define(function(require) {
'use strict';

let co = require('co');

let TaskDefiner = require('../../task_definer');

let GmailLabelMapper = require('../gmail_label_mapper');
let SyncStateHelper = require('../sync_state_helper');

let imapchew = require('../imapchew');
let parseImapDateTime = imapchew.parseImapDateTime;

let a64 = require('../../a64');
let parseGmailConvId = a64.parseUI64;


/**
 * This is the steady-state sync task that drives all of our gmail sync.
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'sync_refresh',
    // The folderId is an optional focal folder of interest.  This matters for
    // the base-case where we've never synchronized the folder intentionally,
    // and so a sync_grow is the appropriate course of action.
    args: ['accountId', 'folderId'],

    exclusiveResources: [
      // Only one of us/sync_grow is allowed to be active at a time.
      (args) => `sync:${args.accountId}`,
    ],

    execute: co.wrap(function*(ctx, req) {
      // -- Exclusively acquire the sync state for the account
      // XXX duplicated boilerplate from sync_grow; prettify/normalize
      let syncReqMap = new Map();
      syncReqMap.set(req.accountId, null);
      yield ctx.beginMutate({
        syncStates: syncReqMap
      });
      let rawSyncState = syncReqMap.get(req.accountId);

      // -- Check to see if we need to spin-off a sync_grow instead
      if (!rawSyncState) {
        yield ctx.finishTask({
          // we ourselves are done
          taskState: null,
          newData: {
            tasks: [
              {
                type: 'sync_grow',
                accountId: req.accountId,
                // This is reliably the inbox, but this is probably not the
                // right way to do this...
                folderId: req.accountId + '.0'
              }
            ]
          }
        });
        return;
      }
      let syncState = new SyncStateHelper(ctx, rawSyncState, req.accountId,
                                          'refresh');

      let foldersTOC =
        yield ctx.universe.acquireAccountFoldersTOC(ctx, req.accountId);
      let labelMapper = new GmailLabelMapper(foldersTOC);

      let account = yield ctx.universe.acquireAccount(ctx, req.accountId);

      let { mailboxInfo, result: messages } = yield account.pimap.listMessages(
        req.folderId,
        '1:*',
        [
          'UID',
          'INTERNALDATE',
          'X-GM-THRID',
          'X-GM-LABELS',
          // We don't need/want FLAGS for new messsages (ones with a higher UID
          // than we've seen before), but it's potentially kinder to gmail to
          // ask for everything in a single go.
          'FLAGS'
        ],
        {
          byUid: true,
          changedSince: syncState.modseq
        }
      );


      for (let msg of messages) {
        let uid = msg.uid; // already parsed into a number by browserbox
        let dateTS = parseImapDateTime(msg.internaldate);
        let rawConvId = parseGmailConvId(msg['x-gm-thrid']);
        let labelFolderIds = labelMapper.labelsToFolderIds(msg['x-gm-labels']);

        // Is this a new message?
        if (uid > syncState.lastHighUid) {
          // Does this message meet our sync criteria on its own?
          if (syncState.messageMeetsSyncCriteria(dateTS, labelFolderIds)) {
            // (Yes, it's a yay message.)
            // Is this a conversation we already know about?
            if (syncState.isKnownConversation(rawConvId)) {
              syncState.newYayMessageInExistingConv(
                uid, rawConvId, dateTS);
            } else { // no, it's a new conversation to us!
              syncState.newYayMessageInNewConv(uid, rawConvId, dateTS);
            }
          // Okay, it didn't meet it on its own, but does it belong to a
          // conversation we care about?
          } else if (syncState.isKnownRawConvId(rawConvId)) {
            syncState.newMehMessageInExistingConv(uid, rawConvId, dateTS);
          } else { // We don't care.
            syncState.newMootMessage(uid);
          }
        } else { // It's an existing message
          if (syncState.messageMeetsSyncCriteria(dateTS, labelFolderIds)) {
            // it's currently a yay message, but was it always a yay message?
            if (syncState.yayUids.has(uid)) {
              // yes, forever awesome.
              syncState.existingMessageUpdated(uid, rawConvId, dateTS);
            } else if (syncState.mehUids.has(uid)) {
              // no, it was meh, but is now suddenly fabulous
              syncState.existingMehMessageIsNowYay(uid, rawConvId, dateTS);
            } else {
              // Not aware of the message, so inductively this conversation is
              // new to us.
              syncState.existingIgnoredMessageIsNowYayInNewConv(
                uid, rawConvId, dateTS);
            }
          // Okay, so not currently a yay message, but was it before?
          } else if (syncState.yayUids.has(uid)) {
            // it was yay, is now meh, this potentially even means we no longer
            // care about the conversation at all
            syncState.existingYayMessageIsNowMeh(uid, rawConvId, dateTS);
          } else if (syncState.mehUids.has(uid)) {
            // it was meh, it's still meh, it's just an update
            syncState.existingMessageUpdated(uid, rawConvId, dateTS);
          } else {
            syncState.existingMootMessage(uid);

          }
        }
      }

      syncState.lastHighUid = mailboxInfo.uidNext - 1;
      syncState.modseq = mailboxInfo.highestModeq;
      syncState.finalizePendingRemovals();

      yield ctx.finishTask({
        mutations: {
          syncStates: syncReqMap,
        },
        newData: {
          tasks: syncState.rawSyncState
        }
      })
    })
  }
]);
});