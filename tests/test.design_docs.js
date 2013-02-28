/*globals initTestDB: false, emit: true, generateAdapterUrl: false */
/*globals PERSIST_DATABASES: false, initDBPair: false, utils: true */
/*globals ajax: true, LevelPouch: true */

"use strict";

var adapters = ['local-1', 'http-1'];
var qunit = module;

// if we are running under node.js, set things up
// a little differently, and only test the leveldb adapter
if (typeof module !== undefined && module.exports) {
  Pouch = require('../src/pouch.js');
  LevelPouch = require('../src/adapters/pouch.leveldb.js');
  utils = require('./test.utils.js');

  for (var k in utils) {
    global[k] = global[k] || utils[k];
  }
  qunit = QUnit.module;
}

adapters.map(function(adapter) {

  qunit("design_docs: " + adapter, {
    setup : function () {
      this.name = generateAdapterUrl(adapter);
    },
    teardown: function() {
      if (!PERSIST_DATABASES) {
        Pouch.destroy(this.name);
      }
    }
  });

  var doc = {
    _id: '_design/foo',
    views: {
      scores: {
        map: 'function(doc) { if (doc.score) { emit(null, doc.score); } }',
        reduce: 'function(keys, values, rereduce) { return sum(values); }'
      }
    },
    filters: {
      even: 'function(doc) { return doc.integer % 2 === 0; }'
    }
  };

  asyncTest("Test writing design doc", function () {
    initTestDB(this.name, function(err, db) {
      db.post(doc, function (err, info) {
        ok(!err, 'Wrote design doc');
        db.get('_design/foo', function (err, info) {
          ok(!err, 'Read design doc');
          start();
        });
      });
    });
  });

  asyncTest("Changes filter", function() {
    // xxx
    initTestDB(this.name, function(err, db) {
      var changes = db.changes({
        onChange: function(change) {
          console.log('whatever');
        },
        continuous: true
      });
      changes.cancel();
      ok('ok');
      start();
    });
  });

  asyncTest("Basic views", function () {

    var docs1 = [
      doc,
      {_id: "dale", score: 3},
      {_id: "mikeal", score: 5},
      {_id: "max", score: 4},
      {_id: "nuno", score: 3}
    ];

    initTestDB(this.name, function(err, db) {
      db.bulkDocs({docs: docs1}, function(err, info) {
        db.query('foo/scores', {reduce: false}, function(err, result) {
          equal(result.rows.length, 4, 'Correct # of results');
          db.query('foo/scores', function(err, result) {
            equal(result.rows[0].value, 15, 'Reduce gave correct result');
            start();
          });
        });
      });
    });
  });

  asyncTest("Concurrent queries", function() {
    initTestDB(this.name, function(err, db) {
      db.bulkDocs({docs: [doc, {_id: "dale", score: 3}]}, function(err, info) {
        var cnt = 0;
        db.query('foo/scores', {reduce: false}, function(err, result) {
          equal(result.rows.length, 1, 'Correct # of results');
          if (cnt++ === 1) { 
            start();
          }
        });
        db.query('foo/scores', {reduce: false}, function(err, result) {
          equal(result.rows.length, 1, 'Correct # of results');
          if (cnt++ === 1) {
            start();
          }
        });
      });
    });
  });

});
