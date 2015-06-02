define(function(require, exports, module) {
'use strict';

var logic = require('./logic');
// XXX proper logging configuration for the front-end too once things start
// working happily.
logic.realtimeLogEverything = true;

// Use a relative link so that consumers do not need to create
// special config to use main-frame-setup.
var addressparser = require('./ext/addressparser');
var evt = require('evt');

var MailAccount = require('./clientapi/mail_account');
var MailSenderIdentity = require('./clientapi/mail_sender_identity');
var MailFolder = require('./clientapi/mail_folder');
var ContactCache = require('./clientapi/contact_cache');
var UndoableOperation = require('./clientapi/undoable_operation');

var AccountsViewSlice = require('./clientapi/accounts_view_slice');
var FoldersListView = require('./clientapi/folders_list_view');
var ConversationsListView = require('./clientapi/conversations_list_view');
var MessagesListView = require('./clientapi/messages_list_view');

var MessageComposition = require('./clientapi/message_composition');

var Linkify = require('./clientapi/bodies/linkify');

function objCopy(obj) {
  var copy = {};
  Object.keys(obj).forEach(function (key) {
    copy[key] = obj[key];
  });
  return copy;
}

// For testing
exports._MailFolder = MailFolder;

var LEGAL_CONFIG_KEYS = [];

/**
 * Error reporting helper; we will probably eventually want different behaviours
 * under development, under unit test, when in use by QA, advanced users, and
 * normal users, respectively.  By funneling all errors through one spot, we
 * help reduce inadvertent breakage later on.
 */
function reportError() {
  console.error.apply(console, arguments);
  var msg = null;
  for (var i = 0; i < arguments.length; i++) {
    if (msg) {
      msg += ' ' + arguments[i];
    } else {
      msg = '' + arguments[i];
    }
  }
  logic.fail(msg);
  throw new Error(msg);
}
var unexpectedBridgeDataError = reportError,
    internalError = reportError,
    reportClientCodeError = reportError;


/**
 * The public API exposed to the client via the MailAPI global.
 */
function MailAPI() {
  evt.Emitter.call(this);
  logic.defineScope(this, 'MailAPI', {});
  this._nextHandle = 1;

  /**
   * @type {Map<Handle, UpdateableObject>}
   *
   * The current mapping for listeners registered with _trackItemUpdates and
   * not yet canceled with _stopTrackingItemUpdates.  This uses the same handle
   * space as _slices and _pendingRequests.
   */
  this._trackedItemHandles = new Map();
  this._pendingRequests = {};
  this._liveBodies = {};

  // Store bridgeSend messages received before back end spawns.
  this._storedSends = [];

  this._processingMessage = null;
  /**
   * List of received messages whose processing is being deferred because we
   * still have a message that is actively being processed, as stored in
   * `_processingMessage`.
   */
  this._deferredMessages = [];

  /**
   * @dict[
   *   @key[debugLogging]
   *   @key[checkInterval]
   * ]{
   *   Configuration data.  This is currently populated by data from
   *   `MailUniverse.exposeConfigForClient` by the code that constructs us.  In
   *   the future, we will probably want to ask for this from the `MailUniverse`
   *   directly over the wire.
   *
   *   This should be treated as read-only.
   * }
   */
  this.config = {};

  /* PROPERLY DOCUMENT EVENT 'badlogin'
   * @func[
   *   @args[
   *     @param[account MailAccount]
   *   ]
   * ]{
   *   A callback invoked when we fail to login to an account and the server
   *   explicitly told us the login failed and we have no reason to suspect
   *   the login was temporarily disabled.
   *
   *   The account is put in a disabled/offline state until such time as the
   *
   * }
   */

  ContactCache.init();

  // Default slices:
  this.accounts = this.viewAccounts({ autoViewFolders: true });
}
exports.MailAPI = MailAPI;
MailAPI.prototype = evt.mix({
  toString: function() {
    return '[MailAPI]';
  },
  toJSON: function() {
    return { type: 'MailAPI' };
  },

  // This exposure as "utils" exists for legacy reasons right now, we should
  // probably just move consumers to directly require the module.
  utils: Linkify,

  extractAccountIdFromFolderId: function(folderId) {
    var lastDot = folderId.lastIndexOf('.');
    return folderId.substring(0, lastDot);
  },

  extractAccountIdFromMessageId: function(messageId) {
    var firstDot = messageId.indexOf('.');
    return messageId.substring(0, firstDot);
  },

  eventuallyGetAccountById: function(accountId) {
    return this.accounts.eventuallyGetAccountById(accountId);
  },

  eventuallyGetFolderById: function(folderId) {
    var accountId = this.extractAccountIdFromFolderId(folderId);
    return this.accounts.eventuallyGetAccountById(accountId).then(
      function gotAccount(account) {
        console.log('got the account');
        return account.folders.eventuallyGetFolderById(folderId);
      },
      function() {
        console.log('SOMEHOW REJECTED?!');
      }
    );
  },

  /**
   * Convert the folder id's for a message into MailFolder instances by looking
   * them up from the account's folders list view.
   *
   * XXX deal with the potential asynchrony of this method being called before
   * the account is known to us.  We should generally be fine, but we don't have
   * the guards in place to actually protect us.
   */
  _mapLabels: function(messageId, folderIds) {
    let accountId = this.extractAccountIdFromMessageId(messageId);
    let account = this.accounts.getAccountById(accountId);
    if (!account) {
      console.warn('the possible has happened; unable to find account with id',
                   accountId);
    }
    let folders = account.folders;
    return folderIds.map((folderId) => {
      return folders.getFolderById(folderId);
    });
  },

  /**
   * Send a message over/to the bridge.  The idea is that we (can) communicate
   * with the backend using only a postMessage-style JSON channel.
   */
  __bridgeSend: function(msg) {
    // This method gets clobbered eventually once back end worker is ready.
    // Until then, it will store calls to send to the back end.

    this._storedSends.push(msg);
  },

  /**
   * Process a message received from the bridge.
   */
  __bridgeReceive: function(msg) {
    // Pong messages are used for tests
    if (this._processingMessage && msg.type !== 'pong') {
      logic(this, 'deferMessage', { type: msg.type });
      this._deferredMessages.push(msg);
    }
    else {
      logic(this, 'immediateProcess', { type: msg.type });
      this._processMessage(msg);
    }
  },

  _processMessage: function ma__processMessage(msg) {
    var methodName = '_recv_' + msg.type;
    if (!(methodName in this)) {
      unexpectedBridgeDataError('Unsupported message type:', msg.type);
      return;
    }
    try {
      logic(this, 'processMessage', { type: msg.type });
      var promise = this[methodName](msg);
      if (promise && promise.then) {
        this._processingMessage = promise;
        promise.then(this._doneProcessingMessage.bind(this, msg));
      }
    }
    catch (ex) {
      internalError('Problem handling message type:', msg.type, ex,
                    '\n', ex.stack);
      return;
    }
  },

  _doneProcessingMessage: function(msg) {
    if (this._processingMessage && this._processingMessage !== msg) {
      throw new Error('Mismatched message completion!');
    }

    this._processingMessage = null;
    while (this._processingMessage === null && this._deferredMessages.length) {
      this._processMessage(this._deferredMessages.shift());
    }
  },

  _recv_badLogin: function ma__recv_badLogin(msg) {
    this.emit('badlogin',
              new MailAccount(this, msg.account, null),
              msg.problem,
              msg.whichSide);
  },


  /**
   * Internal-only API for tracking updates for use by instantiated objects to
   * register to receive updates of themselves independent of the slice
   * mechanism for updates.
   *
   * @return {Handle}
   *   A handle that you must use in a call to _stopTrackingItemUpdates at some
   *   point unless you like leaks.
   */
  _trackItemUpdates: function(itemType, itemId, updateableObject, priorityTags){
    var handle = this._nextHandle++;
    this._trackedItemHandles.set(handle, updateableObject);
    this.__bridgeSend({
      type: 'trackItemUpdates',
      handle: handle,
      itemType: itemType,
      itemId: itemId
    });
    return handle;
  },

  _updateTrackedItemPriorityTags: function(handle, priorityTags) {
    this.__bridgeSend({
      type: 'updateTrackedItemPriorityTags',
      handle: handle,
      priorityTags: priorityTags
    });
  },

  _stopTrackingItemUpdates: function(handle) {
    this._trackedItemHandles.delete(handle);
    this.__bridgeSend({
      type: 'stopTrackingItemUpdates',
      handle: handle
    });
  },

  _recv_update: function(msg) {
    for (let handle of msg.handles) {
      let updateableObject = this._trackedItemHandles.get(handle);
      if (updateableObject) {
        // XXX body updates used to relay delta information, primarily for the
        // benefit of complex sub-objects like the MailAttachment instances.  It
        // may be appropriate
        updateableObject.__update(msg.data);
      }
    }
  },

  _recv_contextDead: function(msg) {
    let thing = this._trackedItemHandles.get(msg.handle);
    if (thing && thing.__dead) {
      thing.__dead();
    }
    this._trackedItemHandles.delete(msg.handle);
  },

  _downloadBodyReps: function(messageId, messageDate) {
    this.__bridgeSend({
      type: 'downloadBodyReps',
      id: messageId,
      date: messageDate
    });
  },

  _recv_bodyModified: function(msg) {
    var body = this._liveBodies[msg.handle];

    if (!body) {
      unexpectedBridgeDataError('body modified for dead handle', msg.handle);
      // possible but very unlikely race condition where body is modified while
      // we are removing the reference to the observer...
      return;
    }

    var wireRep = msg.bodyInfo;
    // We update the body representation regardless of whether there is an
    // onchange listener because the body may contain Blob handles that need to
    // be updated so that in-memory blobs that have been superseded by on-disk
    // Blobs can be garbage collected.
    body.__update(wireRep, msg.detail);

    body.emit('change', msg.detail, body);
  },

  _recv_bodyDead: function(msg) {
    var body = this._liveBodies[msg.handle];

    if (body) {
      body.emit('dead');
    }

    delete this._liveBodies[msg.handle];
  },

  _downloadAttachments: function(body, relPartIndices, attachmentIndices,
                                 registerAttachments,
                                 callWhenDone, callOnProgress) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'downloadAttachments',
      body: body,
      relParts: relPartIndices.length > 0,
      attachments: attachmentIndices.length > 0,
      callback: callWhenDone,
      progress: callOnProgress
    };
    this.__bridgeSend({
      type: 'downloadAttachments',
      handle: handle,
      suid: body.id,
      date: body._date,
      relPartIndices: relPartIndices,
      attachmentIndices: attachmentIndices,
      registerAttachments: registerAttachments
    });
  },

  _recv_downloadedAttachments: function(msg) {
    var req = this._pendingRequests[msg.handle];
    if (!req) {
      unexpectedBridgeDataError('Bad handle for got body:', msg.handle);
      return;
    }
    delete this._pendingRequests[msg.handle];

    // We used to update the attachment representations here.  This is now
    // handled by `bodyModified` notifications which are guaranteed to occur
    // prior to this callback being invoked.

    if (req.callback)
      req.callback.call(null, req.body);
  },

  /**
   * Given a user's email address, try and see if we can autoconfigure the
   * account and what information we'll need to configure it, specifically
   * a password or if XOAuth2 credentials will be needed.
   *
   * @param {Object} details
   * @param {String} details.emailAddress
   *   The user's email address.
   * @param {Function} callback
   *   Invoked once we have an answer.  The object will look something like
   *   one of the following results:
   *
   *   No autoconfig information is available and the user has to do manual
   *   setup:
   *
   *     {
   *       result: 'no-config-info',
   *       configInfo: null
   *     }
   *
   *   Autoconfig information is available and to complete the autoconfig
   *   we need the user's password.  For IMAP and POP3 this means we know
   *   everything we need and can actually create the account.  For ActiveSync
   *   we actually need the password to try and perform autodiscovery.
   *
   *     {
   *       result: 'need-password',
   *       configInfo: { incoming, outgoing }
   *     }
   *
   *   Autoconfig information is available and XOAuth2 authentication should
   *   be attempted and those credentials then provided to us.
   *
   *     {
   *       result: 'need-oauth2',
   *       configInfo: {
   *         incoming,
   *         outgoing,
   *         oauth2Settings: {
   *           secretGroup: 'google' or 'microsoft' or other arbitrary string,
   *           authEndpoint: 'url to the auth endpoint',
   *           tokenEndpoint: 'url to where you ask for tokens',
   *           scope: 'space delimited list of scopes to request'
   *         }
   *       }
   *     }
   *
   *   A `source` property will also be present in the result object.  Its
   *   value will be one of: 'hardcoded', 'local', 'ispdb',
   *   'autoconfig-subdomain', 'autoconfig-wellknown', 'mx local', 'mx ispdb',
   *   'autodiscover'.
   */
  learnAboutAccount: function(details, callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'learnAboutAccount',
      details: details,
      callback: callback
    };
    this.__bridgeSend({
      type: 'learnAboutAccount',
      handle: handle,
      details: details
    });
  },

  _recv_learnAboutAccountResults: function(msg) {
    var req = this._pendingRequests[msg.handle];
    if (!req) {
      unexpectedBridgeDataError('Bad handle:', msg.handle);
      return;
    }
    delete this._pendingRequests[msg.handle];

    req.callback.call(null, msg.data);
  },


  /**
   * Try to create an account.  There is currently no way to abort the process
   * of creating an account.  You really want to use learnAboutAccount before
   * you call this unless you are an automated test.
   *
   * @typedef[AccountCreationError @oneof[
   *   @case['offline']{
   *     We are offline and have no network access to try and create the
   *     account.
   *   }
   *   @case['no-dns-entry']{
   *     We couldn't find the domain name in question, full stop.
   *
   *     Not currently generated; eventually desired because it suggests a typo
   *     and so a specialized error message is useful.
   *   }
   *   @case['no-config-info']{
   *     We were unable to locate configuration information for the domain.
   *   }
   *   @case['unresponsive-server']{
   *     Requests to the server timed out.  AKA we sent packets into a black
   *     hole.
   *   }
   *   @case['port-not-listening']{
   *     Attempts to connect to the given port on the server failed.  We got
   *     packets back rejecting our connection.
   *
   *     Not currently generated; primarily desired because it is very useful if
   *     we are domain guessing.  Also desirable for error messages because it
   *     suggests a user typo or the less likely server outage.
   *   }
   *   @case['bad-security']{
   *     We were able to connect to the port and initiate TLS, but we didn't
   *     like what we found.  This could be a mismatch on the server domain,
   *     a self-signed or otherwise invalid certificate, insufficient crypto,
   *     or a vulnerable server implementation.
   *   }
   *   @case['bad-user-or-pass']{
   *     The username and password didn't check out.  We don't know which one
   *     is wrong, just that one of them is wrong.
   *   }
   *   @case['bad-address']{
   *     The e-mail address provided was rejected by the SMTP probe.
   *   }
   *   @case['pop-server-not-great']{
   *     The POP3 server doesn't support IDLE and TOP, so we can't use it.
   *   }
   *   @case['imap-disabled']{
   *     IMAP support is not enabled for the Gmail account in use.
   *   }
   *   @case['pop3-disabled']{
   *     POP3 support is not enabled for the Gmail account in use.
   *   }
   *   @case['needs-oauth-reauth']{
   *     The OAUTH refresh token was invalid, or there was some problem with
   *     the OAUTH credentials provided. The user needs to go through the
   *     OAUTH flow again.
   *   }
   *   @case['not-authorized']{
   *     The username and password are correct, but the user isn't allowed to
   *     access the mail server.
   *   }
   *   @case['server-problem']{
   *     We were able to talk to the "server" named in the details object, but
   *     we encountered some type of problem.  The details object will also
   *     include a "status" value.
   *   }
   *   @case['server-maintenance']{
   *     The server appears to be undergoing maintenance, at least for this
   *     account.  We infer this if the server is telling us that login is
   *     disabled in general or when we try and login the message provides
   *     positive indications of some type of maintenance rather than a
   *     generic error string.
   *   }
   *   @case['user-account-exists']{
   *     If the user tries to create an account which is already configured.
   *     Should not be created. We will show that account is already configured
   *   }
   *   @case['unknown']{
   *     We don't know what happened; count this as our bug for not knowing.
   *   }
   *   @case[null]{
   *     No error, the account was created and everything is terrific.
   *   }
   * ]]
   *
   * @param {Object} details
   * @param {String} details.emailAddress
   * @param {String} [details.password]
   *   The user's password
   * @param {Object} [configInfo]
   *   If continuing an autoconfig initiated by learnAboutAccount, the
   *   configInfo it returned as part of its results, although you will need
   *   to poke the following structured properties in if you're doing the oauth2
   *   thing:
   *
   *     {
   *       oauth2Secrets: { clientId, clientSecret }
   *       oauth2Tokens: { accessToken, refreshToken, expireTimeMS }
   *     }
   *
   *   If performing a manual config, a manually created configInfo object of
   *   the following form:
   *
   *     {
   *       incoming: { hostname, port, socketType, username, password }
   *       outgoing: { hostname, port, socketType, username, password }
   *     }
   *
   *
   *
   * @param {Function} callback
   *   The callback to invoke upon success or failure.  The callback will be
   *   called with 2 arguments in the case of failure: the error string code,
   *   and the error details object.
   *
   *
   * @args[
   *   @param[details @dict[
   *     @key[displayName String]{
   *       The name the (human, per EULA) user wants to be known to the world
   *       as.
   *     }
   *     @key[emailAddress String]
   *     @key[password String]
   *   ]]
   *   @param[callback @func[
   *     @args[
   *       @param[err AccountCreationError]
   *       @param[errDetails @dict[
   *         @key[server #:optional String]{
   *           The server we had trouble talking to.
   *         }
   *         @key[status #:optional @oneof[Number String]]{
   *           The HTTP status code number, or "timeout", or something otherwise
   *           providing detailed additional information about the error.  This
   *           is usually too technical to be presented to the user, but is
   *           worth encoding with the error name proper if possible.
   *         }
   *       ]]
   *     ]
   *   ]
   * ]
   */
  tryToCreateAccount: function ma_tryToCreateAccount(details, domainInfo,
                                                     callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'tryToCreateAccount',
      details: details,
      domainInfo: domainInfo,
      callback: callback
    };
    this.__bridgeSend({
      type: 'tryToCreateAccount',
      handle: handle,
      details: details,
      domainInfo: domainInfo
    });
  },

  _recv_tryToCreateAccountResults:
      function ma__recv_tryToCreateAccountResults(msg) {
    var req = this._pendingRequests[msg.handle];
    if (!req) {
      unexpectedBridgeDataError('Bad handle for create account:', msg.handle);
      return;
    }
    delete this._pendingRequests[msg.handle];

    // (On failure, there is no account.)
    if (msg.account) {
      // Pull the account out of our automatically created accounts slice.  We
      // guarantee that slice notification went out over the bridge prior to
      // this notification so we can just pull it out of the slice.
      // XXX THE ABOVE IS LIES!  THIS IS NOT CURRENTLY GUARANTEED!  I NEED TO
      // FIX THIS!
      this.accounts.eventuallyGetAccountById(msg.account.id).then((account) => {
        req.callback.call(null, msg.error, msg.errorDetails, account);
      });
    } else {
      req.callback.call(null, msg.error, msg.errorDetails, null);
    }
  },

  _clearAccountProblems: function ma__clearAccountProblems(account, callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'clearAccountProblems',
      callback: callback,
    };
    this.__bridgeSend({
      type: 'clearAccountProblems',
      accountId: account.id,
      handle: handle,
    });
  },

  _recv_clearAccountProblems: function ma__recv_clearAccountProblems(msg) {
    var req = this._pendingRequests[msg.handle];
    delete this._pendingRequests[msg.handle];
    req.callback && req.callback();
  },

  _modifyAccount: function ma__modifyAccount(account, mods, callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'modifyAccount',
      callback: callback,
    };
    this.__bridgeSend({
      type: 'modifyAccount',
      accountId: account.id,
      mods: mods,
      handle: handle
    });
  },

  _recv_modifyAccount: function(msg) {
    var req = this._pendingRequests[msg.handle];
    delete this._pendingRequests[msg.handle];
    req.callback && req.callback();
  },

  _deleteAccount: function ma__deleteAccount(account) {
    this.__bridgeSend({
      type: 'deleteAccount',
      accountId: account.id,
    });
  },

  _modifyIdentity: function ma__modifyIdentity(identity, mods, callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'modifyIdentity',
      callback: callback,
    };
    this.__bridgeSend({
      type: 'modifyIdentity',
      identityId: identity.id,
      mods: mods,
      handle: handle
    });
  },

  _recv_modifyIdentity: function(msg) {
    var req = this._pendingRequests[msg.handle];
    delete this._pendingRequests[msg.handle];
    req.callback && req.callback();
  },

  /**
   * Get the list of accounts.  This can be used for the list of accounts in
   * setttings or for a folder tree where only one account's folders are visible
   * at a time.
   *
   * @param {Object} [opts]
   * @param {Boolean} [opts.autoViewFolders=false]
   *   Should the `MailAccount` instances automatically issue viewFolders
   *   requests and assign them to a "folders" property?
   */
  viewAccounts: function ma_viewAccounts(opts) {
    var handle = this._nextHandle++,
        slice = new AccountsViewSlice(this, handle, opts);
    this._trackedItemHandles.set(handle, slice);

    this.__bridgeSend({
      type: 'viewAccounts',
      handle: handle,
    });
    return slice;
  },

  /**
   * Retrieve the entire folder hierarchy for either 'navigation' (pick what
   * folder to show the contents of, including unified folders), 'movetarget'
   * (pick target folder for moves, does not include unified folders), or
   * 'account' (only show the folders belonging to a given account, implies
   * selection).  In all cases, there may exist non-selectable folders such as
   * the account roots or IMAP folders that cannot contain messages.
   *
   * When accounts are presented as folders via this UI, they do not expose any
   * of their `MailAccount` semantics.
   *
   * @args[
   *   @param[mode @oneof['navigation' 'movetarget' 'account']
   *   @param[argument #:optional]{
   *     Arguent appropriate to the mode; currently will only be a `MailAccount`
   *     instance.
   *   }
   * ]
   */
  viewFolders: function ma_viewFolders(mode, accountId) {
    var handle = this._nextHandle++,
        slice = new FoldersListView(this, handle);

    this._trackedItemHandles.set(handle, slice);

    this.__bridgeSend({
      type: 'viewFolders',
      mode: mode,
      handle: handle,
      accountId: accountId
    });

    return slice;
  },

  /**
   * View the conversations in a folder.
   */
  viewFolderConversations: function(folder) {
    var handle = this._nextHandle++,
        slice = new ConversationsListView(this, handle);
    slice.folderId = folder.id;
    this._trackedItemHandles.set(handle, slice);

    this.__bridgeSend({
      type: 'viewFolderConversations',
      folderId: folder.id,
      handle: handle,
    });

    return slice;
  },

  viewConversationMessages: function(convOrId) {
    var handle = this._nextHandle++,
        slice = new MessagesListView(this, handle);
    slice.conversationId = (typeof(convOrId) === 'string' ? convOrId :
                              convOrId.id);
    this._trackedItemHandles.set(handle, slice);

    this.__bridgeSend({
      type: 'viewConversationMessages',
      conversationId: slice.conversationId,
      handle: handle,
    });

    return slice;
  },

  /**
   * Search a folder for messages containing the given text in the sender,
   * recipients, or subject fields, as well as (optionally), the body with a
   * default time constraint so we don't entirely kill the server or us.
   *
   * @args[
   *   @param[folder]{
   *     The folder whose messages we should search.
   *   }
   *   @param[text]{
   *     The phrase to search for.  We don't split this up into words or
   *     anything like that.  We just do straight-up indexOf on the whole thing.
   *   }
   *   @param[whatToSearch @dict[
   *     @key[author #:optional Boolean]
   *     @key[recipients #:optional Boolean]
   *     @key[subject #:optional Boolean]
   *     @key[body #:optional @oneof[false 'no-quotes' 'yes-quotes']]
   *   ]]
   * ]
   */
  searchFolderMessages:
      function ma_searchFolderMessages(folder, text, whatToSearch) {
    var handle = this._nextHandle++,
        slice = new HeadersViewSlice(this, handle, 'matchedHeaders');
    // the initial population counts as a request.
    slice.pendingRequestCount++;
    this._slices[handle] = slice;

    this.__bridgeSend({
      type: 'searchFolderMessages',
      folderId: folder.id,
      handle: handle,
      phrase: text,
      whatToSearch: whatToSearch,
    });

    return slice;
  },

  //////////////////////////////////////////////////////////////////////////////
  // Batch Message Mutation
  //
  // If you want to modify a single message, you can use the methods on it
  // directly.
  //
  // All actions are undoable and return an `UndoableOperation`.

  deleteMessages: function ma_deleteMessages(messages) {
    // We allocate a handle that provides a temporary name for our undoable
    // operation until we hear back from the other side about it.
    var handle = this._nextHandle++;

    var undoableOp = new UndoableOperation(this, 'delete', messages.length,
                                           handle),
        msgSuids = messages.map(serializeMessageName);

    this._pendingRequests[handle] = {
      type: 'mutation',
      handle: handle,
      undoableOp: undoableOp
    };
    this.__bridgeSend({
      type: 'deleteMessages',
      handle: handle,
      messages: msgSuids,
    });

    return undoableOp;
  },

  // Copying messages is not required yet.
  /*
  copyMessages: function ma_copyMessages(messages, targetFolder) {
  },
  */

  moveMessages: function ma_moveMessages(messages, targetFolder, callback) {
    // We allocate a handle that provides a temporary name for our undoable
    // operation until we hear back from the other side about it.
    var handle = this._nextHandle++;

    var undoableOp = new UndoableOperation(this, 'move', messages.length,
                                           handle),
        msgSuids = messages.map(serializeMessageName);

    this._pendingRequests[handle] = {
      type: 'mutation',
      handle: handle,
      undoableOp: undoableOp,
      callback: callback
    };
    this.__bridgeSend({
      type: 'moveMessages',
      handle: handle,
      messages: msgSuids,
      targetFolder: targetFolder.id
    });

    return undoableOp;
  },

  markMessagesRead: function ma_markMessagesRead(messages, beRead) {
    return this.modifyMessageTags(messages,
                                  beRead ? ['\\Seen'] : null,
                                  beRead ? null : ['\\Seen'],
                                  beRead ? 'read' : 'unread');
  },

  markMessagesStarred: function ma_markMessagesStarred(messages, beStarred) {
    return this.modifyMessageTags(messages,
                                  beStarred ? ['\\Flagged'] : null,
                                  beStarred ? null : ['\\Flagged'],
                                  beStarred ? 'star' : 'unstar');
  },

  modifyMessageTags: function ma_modifyMessageTags(messages, addTags,
                                                   removeTags, _opcode) {
    // We allocate a handle that provides a temporary name for our undoable
    // operation until we hear back from the other side about it.
    var handle = this._nextHandle++;

    if (!_opcode) {
      if (addTags && addTags.length)
        _opcode = 'addtag';
      else if (removeTags && removeTags.length)
        _opcode = 'removetag';
    }
    var undoableOp = new UndoableOperation(this, _opcode, messages.length,
                                           handle),
        msgSuids = messages.map(serializeMessageName);

    this._pendingRequests[handle] = {
      type: 'mutation',
      handle: handle,
      undoableOp: undoableOp
    };
    this.__bridgeSend({
      type: 'modifyMessageTags',
      handle: handle,
      opcode: _opcode,
      addTags: addTags,
      removeTags: removeTags,
      messages: msgSuids,
    });

    return undoableOp;
  },

  /**
   * Check the outbox for pending messages, and initiate a series of
   * jobs to attempt to send them. The callback fires after the first
   * message's send attempt completes; this job will then
   * self-schedule further jobs to attempt to send the rest of the
   * outbox.
   *
   * @param {MailAccount} account
   * @param {function} callback
   *   Called after the first message's send attempt finishes.
   */
  sendOutboxMessages: function (account, callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'sendOutboxMessages',
      callback: callback
    };
    this.__bridgeSend({
      type: 'sendOutboxMessages',
      accountId: account.id,
      handle: handle
    });
  },

  _recv_sendOutboxMessages: function(msg) {
    var req = this._pendingRequests[msg.handle];
    delete this._pendingRequests[msg.handle];
    req.callback && req.callback();
  },

  /**
   * Enable or disable outbox syncing for this account. This is
   * generally a temporary measure, used when the user is actively
   * editing the list of outbox messages and we don't want to
   * inadvertently move something out from under them. This change
   * does _not_ persist; it's meant to be used only for brief periods
   * of time, not as a "sync schedule" coordinator.
   */
  setOutboxSyncEnabled: function (account, enabled, callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'setOutboxSyncEnabled',
      callback: callback
    };
    this.__bridgeSend({
      type: 'setOutboxSyncEnabled',
      accountId: account.id,
      outboxSyncEnabled: enabled,
      handle: handle
    });
  },

  _recv_setOutboxSyncEnabled: function(msg) {
    var req = this._pendingRequests[msg.handle];
    delete this._pendingRequests[msg.handle];
    req.callback && req.callback();
  },

  /**
   * Parse a structured email address
   * into a display name and email address parts.
   * It will return null on a parse failure.
   *
   * @param {String} email A email address.
   * @return {Object} An object of the form { name, address }.
   */
  parseMailbox: function(email) {
    try {
      var mailbox = addressparser.parse(email);
      return (mailbox.length >= 1) ? mailbox[0] : null;
    }
    catch (ex) {
      reportClientCodeError('parse mailbox error', ex,
                            '\n', ex.stack);
      return null;
    }
  },

  _recv_mutationConfirmed: function(msg) {
    var req = this._pendingRequests[msg.handle];
    if (!req) {
      unexpectedBridgeDataError('Bad handle for mutation:', msg.handle);
      return;
    }

    req.undoableOp._tempHandle = null;
    req.undoableOp._longtermIds = msg.longtermIds;
    if (req.undoableOp._undoRequested)
      req.undoableOp.undo();

    if (req.callback) {
      req.callback(msg.result);
    }
  },

  __undo: function undo(undoableOp) {
    this.__bridgeSend({
      type: 'undo',
      longtermIds: undoableOp._longtermIds,
    });
  },

  //////////////////////////////////////////////////////////////////////////////
  // Contact Support

  resolveEmailAddressToPeep: function(emailAddress, callback) {
    var peep = ContactCache.resolvePeep({ name: null, address: emailAddress });
    if (ContactCache.pendingLookupCount)
      ContactCache.callbacks.push(callback.bind(null, peep));
    else
      callback(peep);
  },

  //////////////////////////////////////////////////////////////////////////////
  // Message Composition

  /**
   * Begin the message composition process, creating a MessageComposition that
   * stores the current message state and periodically persists its state to the
   * backend so that the message is potentially available to other clients and
   * recoverable in the event of a local crash.
   *
   * Composition is triggered in the context of a given message and folder so
   * that the correct account and sender identity for composition can be
   * inferred.  Message may be null if there are no messages in the folder.
   * Folder is not required if a message is provided.
   *
   * @args[
   *   @param[message #:optional MailHeader]{
   *     Some message to use as context when not issuing a reply/forward.
   *   }
   *   @param[folder #:optional MailFolder]{
   *     The folder to use as context if no `message` is provided and not
   *     issuing a reply/forward.
   *   }
   *   @param[options #:optional @dict[
   *     @key[replyTo #:optional MailHeader]
   *     @key[replyMode #:optional @oneof[null 'list' 'all']]
   *     @key[forwardOf #:optional MailHeader]
   *     @key[forwardMode #:optional @oneof['inline']]
   *   ]]
   *   @param[callback #:optional Function]{
   *     The callback to invoke once the composition handle is fully populated.
   *     This is necessary because the back-end decides what identity is
   *     appropriate, handles "re:" prefixing, quoting messages, etc.
   *   }
   * ]
   */
  beginMessageComposition: function(message, folder, options, callback) {
    if (!callback)
      throw new Error('A callback must be provided; you are using the API ' +
                      'wrong if you do not.');
    if (!options)
      options = {};

    var handle = this._nextHandle++,
        composer = new MessageComposition(this, handle);

    this._pendingRequests[handle] = {
      type: 'compose',
      composer: composer,
      callback: callback,
    };
    var msg = {
      type: 'beginCompose',
      handle: handle,
      mode: null,
      submode: null,
      refSuid: null,
      refDate: null,
      refGuid: null,
      refAuthor: null,
      refSubject: null,
    };
    if (options.hasOwnProperty('replyTo') && options.replyTo) {
      msg.mode = 'reply';
      msg.submode = options.replyMode;
      msg.refSuid = options.replyTo.id;
      msg.refDate = options.replyTo.date.valueOf();
      msg.refGuid = options.replyTo.guid;
      msg.refAuthor = options.replyTo.author.toWireRep();
      msg.refSubject = options.replyTo.subject;
    }
    else if (options.hasOwnProperty('forwardOf') && options.forwardOf) {
      msg.mode = 'forward';
      msg.submode = options.forwardMode;
      msg.refSuid = options.forwardOf.id;
      msg.refDate = options.forwardOf.date.valueOf();
      msg.refGuid = options.forwardOf.guid;
      msg.refAuthor = options.forwardOf.author.toWireRep();
      msg.refSubject = options.forwardOf.subject;
    }
    else {
      msg.mode = 'new';
      if (message) {
        msg.submode = 'message';
        msg.refSuid = message.id;
      }
      else if (folder) {
        msg.submode = 'folder';
        msg.refSuid = folder.id;
      }
    }
    this.__bridgeSend(msg);
    return composer;
  },

  /**
   * Open a message as if it were a draft message (hopefully it is), returning
   * a MessageComposition object that will be asynchronously populated.  The
   * provided callback will be notified once all composition state has been
   * loaded.
   *
   * The underlying message will be replaced by other messages as the draft
   * is updated and effectively deleted once the draft is completed.  (A
   * move may be performed instead.)
   */
  resumeMessageComposition: function(message, callback) {
    if (!callback)
      throw new Error('A callback must be provided; you are using the API ' +
                      'wrong if you do not.');

    var handle = this._nextHandle++,
        composer = new MessageComposition(this, handle);

    this._pendingRequests[handle] = {
      type: 'compose',
      composer: composer,
      callback: callback,
    };

    this.__bridgeSend({
      type: 'resumeCompose',
      handle: handle,
      messageNamer: serializeMessageName(message)
    });

    return composer;
  },

  _recv_composeBegun: function(msg) {
    var req = this._pendingRequests[msg.handle];
    if (!req) {
      unexpectedBridgeDataError('Bad handle for compose begun:', msg.handle);
      return;
    }

    req.composer.senderIdentity = new MailSenderIdentity(this, msg.identity);
    req.composer.subject = msg.subject;
    req.composer.body = msg.body; // rich obj of {text, html}
    req.composer.to = msg.to;
    req.composer.cc = msg.cc;
    req.composer.bcc = msg.bcc;
    req.composer._references = msg.referencesStr;
    req.composer.attachments = msg.attachments;
    req.composer.sendStatus = msg.sendStatus; // For displaying "Send failed".

    if (req.callback) {
      var callback = req.callback;
      req.callback = null;
      callback.call(null, req.composer);
    }
  },

  _composeAttach: function(draftHandle, attachmentDef, callback) {
    if (!draftHandle) {
      return;
    }
    var draftReq = this._pendingRequests[draftHandle];
    if (!draftReq) {
      return;
    }
    var callbackHandle = this._nextHandle++;
    this._pendingRequests[callbackHandle] = {
      type: 'attachBlobToDraft',
      callback: callback
    };
    this.__bridgeSend({
      type: 'attachBlobToDraft',
      handle: callbackHandle,
      draftHandle: draftHandle,
      attachmentDef: attachmentDef
    });
  },

  _recv_attachedBlobToDraft: function(msg) {
    var callbackReq = this._pendingRequests[msg.handle];
    var draftReq = this._pendingRequests[msg.draftHandle];
    if (!callbackReq) {
      return;
    }
    delete this._pendingRequests[msg.handle];

    if (callbackReq.callback && draftReq && draftReq.composer) {
      callbackReq.callback(msg.err, draftReq.composer);
    }
  },

  _composeDetach: function(draftHandle, attachmentIndex, callback) {
    if (!draftHandle) {
      return;
    }
    var draftReq = this._pendingRequests[draftHandle];
    if (!draftReq) {
      return;
    }
    var callbackHandle = this._nextHandle++;
    this._pendingRequests[callbackHandle] = {
      type: 'detachAttachmentFromDraft',
      callback: callback
    };
    this.__bridgeSend({
      type: 'detachAttachmentFromDraft',
      handle: callbackHandle,
      draftHandle: draftHandle,
      attachmentIndex: attachmentIndex
    });
  },

  _recv_detachedAttachmentFromDraft: function(msg) {
    var callbackReq = this._pendingRequests[msg.handle];
    var draftReq = this._pendingRequests[msg.draftHandle];
    if (!callbackReq) {
      return;
    }
    delete this._pendingRequests[msg.handle];

    if (callbackReq.callback && draftReq && draftReq.composer) {
      callbackReq.callback(msg.err, draftReq.composer);
    }
  },

  _composeDone: function(handle, command, state, callback) {
    if (!handle)
      return;
    var req = this._pendingRequests[handle];
    if (!req) {
      return;
    }
    req.type = command;
    if (callback)
      req.callback = callback;
    this.__bridgeSend({
      type: 'doneCompose',
      handle: handle,
      command: command,
      state: state,
    });
  },

  _recv_doneCompose: function(msg) {
    var req = this._pendingRequests[msg.handle];
    if (!req) {
      unexpectedBridgeDataError('Bad handle for doneCompose:', msg.handle);
      return;
    }
    req.active = null;
    // Do not cleanup on saves. Do cleanup on successful send, delete, die.
    if (req.type === 'die' || (!msg.err && (req.type !== 'save')))
      delete this._pendingRequests[msg.handle];
    if (req.callback) {
      req.callback.call(null, {
        sentDate: msg.sentDate,
        messageId: msg.messageId,
        sendStatus: msg.sendStatus
      });
      req.callback = null;
    }
  },

  //////////////////////////////////////////////////////////////////////////////
  // mode setting for back end universe. Set interactive
  // if the user has been exposed to the UI and it is a
  // longer lived application, not just a cron sync.
  setInteractive: function() {
    this.__bridgeSend({
      type: 'setInteractive'
    });
  },

  //////////////////////////////////////////////////////////////////////////////
  // cron syncing

  /**
   * Receive events about the start and stop of periodic syncing
   */
  _recv_cronSyncStart: function ma__recv_cronSyncStart(msg) {
    this.emit('cronsyncstart', msg.accountIds)
  },

  _recv_cronSyncStop: function ma__recv_cronSyncStop(msg) {
    this.emit('cronsyncstop', msg.accountsResults);
  },

  _recv_backgroundSendStatus: function(msg) {
    this.emit('backgroundsendstatus', msg.data);
  },

  //////////////////////////////////////////////////////////////////////////////
  // Localization

  /**
   * Provide a list of localized strings for use in message composition.  This
   * should be a dictionary with the following values, with their expected
   * default values for English provided.  Try to avoid being clever and instead
   * just pick the same strings Thunderbird uses for these for the given locale.
   *
   * - wrote: "{{name}} wrote".  Used for the lead-in to the quoted message.
   * - originalMessage: "Original Message".  Gets put between a bunch of dashes
   *    when forwarding a message inline.
   * - forwardHeaderLabels:
   *   - subject
   *   - date
   *   - from
   *   - replyTo (for the "reply-to" header)
   *   - to
   *   - cc
   */
  useLocalizedStrings: function(strings) {
    this.__bridgeSend({
      type: 'localizedStrings',
      strings: strings
    });
    if (strings.folderNames)
      this.l10n_folder_names = strings.folderNames;
  },

  /**
   * L10n strings for folder names.  These map folder types to appropriate
   * localized strings.
   *
   * We don't remap unknown types, so this doesn't need defaults.
   */
  l10n_folder_names: {},

  l10n_folder_name: function(name, type) {
    if (this.l10n_folder_names.hasOwnProperty(type)) {
      var lowerName = name.toLowerCase();
      // Many of the names are the same as the type, but not all.
      if ((type === lowerName) ||
          (type === 'drafts') ||
          (type === 'junk') ||
          (type === 'queue'))
        return this.l10n_folder_names[type];
    }
    return name;
  },


  //////////////////////////////////////////////////////////////////////////////
  // Configuration

  /**
   * Change one-or-more backend-wide settings; use `MailAccount.modifyAccount`
   * to chang per-account settings.
   */
  modifyConfig: function(mods) {
    for (var key in mods) {
      if (LEGAL_CONFIG_KEYS.indexOf(key) === -1)
        throw new Error(key + ' is not a legal config key!');
    }
    this.__bridgeSend({
      type: 'modifyConfig',
      mods: mods
    });
  },

  _recv_config: function(msg) {
    this.config = msg.config;
  },

  //////////////////////////////////////////////////////////////////////////////
  // Diagnostics / Test Hacks

  /**
   * After a setZeroTimeout, send a 'ping' to the bridge which will send a
   * 'pong' back, notifying the provided callback.  This is intended to be hack
   * to provide a way to ensure that some function only runs after all of the
   * notifications have been received and processed by the back-end.
   *
   * Note that ping messages are always processed as they are received; they do
   * not get deferred like other messages.
   */
  ping: function(callback) {
    var handle = this._nextHandle++;
    this._pendingRequests[handle] = {
      type: 'ping',
      callback: callback,
    };

    // With the introduction of slice batching, we now wait to send the ping.
    // This is reasonable because there are conceivable situations where the
    // caller really wants to wait until all related callbacks fire before
    // dispatching.  And the ping method is already a hack to ensure correctness
    // ordering that should be done using better/more specific methods, so this
    // change is not any less of a hack/evil, although it does cause misuse to
    // potentially be more capable of causing intermittent failures.
    window.setZeroTimeout(function() {
      this.__bridgeSend({
        type: 'ping',
        handle: handle,
      });
    }.bind(this));
  },

  _recv_pong: function(msg) {
    var req = this._pendingRequests[msg.handle];
    delete this._pendingRequests[msg.handle];
    req.callback();
  },

  debugSupport: function(command, argument) {
    if (command === 'setLogging')
      this.config.debugLogging = argument;
    this.__bridgeSend({
      type: 'debugSupport',
      cmd: command,
      arg: argument
    });
  }

  //////////////////////////////////////////////////////////////////////////////
});

}); // end define
