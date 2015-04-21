define(function (require) {

let logic = require('./logic');

/**
 * Provides helpers and standard arguments/context for tasks.
 */
function TaskContext(wrappedTask, universe) {
  logic.defineScope(this, 'TaskContext', { id: wrappedTask.id });
  this.id = wrappedTask.id;
  this._wrappedTask = wrappedTask;
  this.universe = universe;

  this._stuffToRelease = [];
  this._preMutateStates = null;

  /**
   * @type {'prep'|'mutate'|'finishing'}
   */
   this.state = 'prep';
}
TaskContext.prototype = {
  get taskMode() {
    if (this._wrappedTask.state === null) {
      return 'planning';
    } else {
      return 'executing';
    }
  },

  /**
   * Asynchronously acquire a resource and track that we are using it so that
   * when the task completes or is terminated we can automatically release all
   * acquired resources.
   */
  acquire: function(acquireable) {
    this._stuffToRelease.push(acquireable);
    return acquireable.__acquire(this);
  },

  _releaseEverything: function() {
    for (let acquireable of this._stuffToRelease) {
      try {
        acquireable.__release(this);
      } catch (ex) {
        logic(this, 'problem releasing', { what: acquireable, ex: ex });
      }
    }
  },

  read: function(what) {
    return this.universe.db.read(this, what);
  },

  beginMutate: function(what) {
    if (this.state !== 'prep') {
      throw new Error(
        'Cannot switch to mutate state from state: ' + this.state);
    }
    this.state = 'mutate';
    return this.universe.db.beginMutate(this, what);
  },

  /**
   * @param {Object} finishData
   * @param {Object} finishData.mutations
   *   The mutations to finish as a result of the one preceding call to
   *   `beginMutate`.
   * @param {Object} finishData.newData
   *   New records being added to the database.
   * @param {Array<RawTask>} finishData.newData.tasks
   *   The new tasks that should be atomically, persistently tracked as a
   *   deterministic result of this task.
   * @param {Object} [finishData.taskState]
   *   The new state for the task.  Until complex tasks are implemented, this
   *   should always be a real object.  But omit/just pass null if you want
   *   your task no longer tracked because you turn out to be moot, etc.  This
   *   is ignored if the task is in the execute state because the task is
   *   considered concluded for now.  XXX in the future, we will let tasks
   *   re-queue themselves, etc. as part of the error handling logic.
   */
  finishTask: function(finishData) {
    this.state = 'finishing';

    let revisedTaskInfo;
    if (finishData.taskState) {
      // (Either this was the planning stage or an execution stage that didn't
      // actually complete; we're still planned either way.)
      this._wrappedTask.state = 'planned';
      this._wrappedTask.plannedTask = finishData.taskState;
      revisedTaskInfo = {
        id: this.id,
        value: this._wrappedTask
      };
      this.universe.taskManager.__prioritizeTask(this._wrappedTask);
    } else {
      revisedTaskInfo = {
        id: this.id,
        value: null
      };
    }

    // Normalize any tasks that should be byproducts of this task.
    let wrappedTasks = null;
    if (finishData.newData && finishData.newData.tasks) {
      wrappedTasks =
        this.universe.taskManager.__wrapTasks(finishData.newData.tasks);
    }

    return this.universe.db.finishMutate(
      this,
      finishData,
      {
        revisedTaskInfo: revisedTaskInfo,
        wrappedTasks: wrappedTasks
      })
    .then(() => {
      if (wrappedTasks) {
        this.universe.taskManager.__enqueuePersistedTasksForPlanning(
          wrappedTasks);
      }
    });
  },
};
return TaskContext;
});