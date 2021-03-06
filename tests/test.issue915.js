/*globals initTestDB: false, emit: true, generateAdapterUrl: false */
/*globals PERSIST_DATABASES: false, initDBPair: false, utils: true */
/*globals Pouch.ajax: true, LevelPouch: true */

"use strict";

var qunit = module;
var LevelPouch;
var utils;
var fs;

if (typeof module !== undefined && module.exports) {
  PouchDB = require('../lib');
  LevelPouch = require('../lib/adapters/leveldb');
  utils = require('./test.utils.js');
  fs = require('fs');

  for (var k in utils) {
    global[k] = global[k] || utils[k];
  }
  qunit = QUnit.module;
}

qunit("Remove DB", {
  setup: function() {
    //Create a dir
    fs.mkdirSync('veryimportantfiles');
  },
  teardown: function() {
      PouchDB.destroy('name');
      fs.rmdirSync('veryimportantfiles');
  }
});



asyncTest("Create a pouch without DB setup", function() {
  var instantDB;
  instantDB = new PouchDB('name', {skipSetup: true}, function() {
    PouchDB.destroy('veryimportantfiles', function( error, response ) {
        equal(error.reason, 'Database not found', 'should return Database not found error');
        equal(fs.existsSync('veryimportantfiles'), true, 'veryimportantfiles was not removed');
        start();
      });
  });
});


