define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');

return new LegacyGelamTest('(POP3) body updates when attachments change',
                           function(T, RT) {
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A', { universe: testUniverse });

  var eLazy = T.lazyLogger('misc');

  // Set POP3 to not retrieve any of the message when fetching
  // headers. Otherwise it might have already finished downloading
  // short messages, which would make the assertions below
  // inconsistent between prototols.
  testUniverse.do_adjustSyncValues({
    POP3_SNIPPET_SIZE_GOAL: 0
  });

  // Use the inbox, so that POP3 will actually run its sync logic.
  var testFolder = testAccount.do_useExistingFolderWithType('inbox', '');
  testAccount.do_addMessagesToFolder(testFolder, {
    count: 2,
    attachments: [{
      filename: 'stuff.png',
      contentType: 'image/png',
      encoding: 'base64',
      body: 'YWJj\n'
    },{
      filename: 'stuff.png',
      contentType: 'image/png',
      encoding: 'base64',
      body: 'YWJj\n'
    }],
  });


  var testView = testAccount.do_openFolderView(
    'syncs', testFolder, null, null,
    { syncedToDawnOfTime: 'ignore', batches: 1 });

  T.action('body updates attachment', eLazy, function() {
    var header = testView.slice.items[0];

    // 1. We fetch the body, instructing the reps to download
    //    asynchronously. Before the body reps have a chance to
    //    download, we set an "onchange" handler.
    //
    // 2. The initial body returned before we download reps will
    //    expect zero attachments, because we haven't downloaded
    //    enough of the message to actually know. However,
    //    we do know that there _are_ attachments, because of
    //    the multipart/mixed mime type.
    //
    // 3. After the body's "onchange" handler fires, we should see
    //    both attachments listed on the MailBody object. Before this
    //    patch, the MailBody object did not update to include the
    //    correct number of attachments.

    eLazy.expect('initial attachments length',  0);
    eLazy.expect('attachments length',  2);
    eLazy.expect('hasAttachments',  true);
    header.getBody({ downloadBodyReps: true }, function (body) {
      eLazy.log('initial attachments length', body.attachments.length);
      body.onchange = function() {
        eLazy.log('attachments length', body.attachments.length);
        eLazy.log('hasAttachments', true);
      }
    });
  }).timeoutMS = 5000;

});

}); // end define
