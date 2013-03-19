/*globals yankError: false, extend: false, call: false, parseDocId: false, traverseRevTree: false */

"use strict";

/*
 * A generic pouch adapter
 */
var PouchAdapter = function(opts, callback) {


  var api = {};
  var customApi = Pouch.adapters[opts.adapter](opts, function(err, db) {
    if (err) {
      if (callback) {
        callback(err);
      }
      return;
    }

    for (var j in api) {
      if (!db.hasOwnProperty(j)) {
        db[j] = api[j];
      }
    }
    callback(err, db);
  });


  api.post = function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    return customApi.bulkDocs({docs: [doc]}, opts, yankError(callback));
  };

  api.put = function(doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    if (!doc || !('_id' in doc)) {
      return call(callback, Pouch.Errors.MISSING_ID);
    }
    return customApi.bulkDocs({docs: [doc]}, opts, yankError(callback));
  };


  api.putAttachment = function (id, rev, blob, type, callback) {
    if (typeof type === 'function') {
      callback = type;
      type = blob;
      blob = rev;
      rev = null;
    }
    if (typeof type === 'undefined') {
      type = blob;
      blob = rev;
      rev = null;
    }
    id = parseDocId(id);

    function createAttachment(doc) {
      doc._attachments = doc._attachments || {};
      doc._attachments[id.attachmentId] = {
        content_type: type,
        data: blob
      };
      api.put(doc, callback);
    }

    api.get(id.docId, function(err, doc) {
      // create new doc
      if (err && err.error === Pouch.Errors.MISSING_DOC.error) {
        createAttachment({_id: id.docId});
        return;
      }
      if (err) {
        call(callback, err);
        return;
      }

      if (doc._rev !== rev) {
        call(callback, Pouch.Errors.REV_CONFLICT);
        return;
      }

      createAttachment(doc);
    });
  };

  api.removeAttachment = function (id, rev, callback) {
    id = parseDocId(id);
    api.get(id.docId, function(err, obj) {
      if (err) {
        call(callback, err);
        return;
      }

      if (obj._rev !== rev) {
        call(callback, Pouch.Errors.REV_CONFLICT);
        return;
      }

      obj._attachments = obj._attachments || {};
      delete obj._attachments[id.attachmentId];
      api.put(obj, callback);
    });
  };

  api.remove = function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    if (opts === undefined) {
      opts = {};
    }
    opts.was_delete = true;
    var newDoc = extend(true, {}, doc);
    newDoc._deleted = true;
    return customApi.bulkDocs({docs: [newDoc]}, opts, yankError(callback));
  };


  api.revsDiff = function (req, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    var ids = Object.keys(req);
    var count = 0;
    var missing = {};

    function readDoc(err, doc, id) {
      req[id].map(function(revId) {
        var matches = function(x) { return x.rev !== revId; };
        if (!doc || doc._revs_info.every(matches)) {
          if (!missing[id]) {
            missing[id] = {missing: []};
          }
          missing[id].missing.push(revId);
        }
      });

      if (++count === ids.length) {
        return call(callback, null, missing);
      }
    }

    ids.map(function(id) {
      api.get(id, {revs_info: true}, function(err, doc) {
        readDoc(err, doc, id);
      });
    });
  };

  // compact one document and fire callback
  // by compacting we mean removing all revisions which
  // are not leaves in revision tree
  var compactDocument = function(docId, callback) {
    customApi._getRevisionTree(docId, function(rev_tree){
      var nonLeaves = [];
      traverseRevTree(rev_tree, function(isLeaf, pos, id) {
        var rev = pos + '-' + id;
        if (!isLeaf) {
          nonLeaves.push(rev);
        }
      });
      customApi._removeDocRevisions(docId, nonLeaves, callback);
    });
  };
  // compact the whole database using single document
  // compaction
  api.compact = function(callback) {
    api.allDocs(function(err, res) {
      var count = res.rows.length;
      if (!count) {
        call(callback);
        return;
      }
      res.rows.forEach(function(row) {
        compactDocument(row.key, function() {
          count--;
          if (!count) {
            call(callback);
          }
        });
      });
    });
  };


  /* Begin api wrappers. Specific functionality to storage belongs in the _[method] */
  api._genericGet = function(id, opts, callback) {
    customApi._getMetadata(id, function (metadata, ctx){
      if (!metadata || (isDeleted(metadata, opts.rev) && !opts.rev)) {
        call(callback, Pouch.Errors.MISSING_DOC);
        return;
      }
      var rev = Pouch.merge.winningRev(metadata);
      var key = opts.rev ? opts.rev : rev;


      customApi._getDocument(id, key, ctx, function(doc){
        var result;
        if (!doc) {
          return call(Pouch.Errors.MISSING_DOC);
        }

        if (opts.attachments && doc._attachments) {
          var attachments = Object.keys(doc._attachments);
          var recv = 0;

          attachments.forEach(function(key) {
            // FIXME: we should pass only ctx (so every adapter can pass whatever it needs to)
            api.getAttachment(doc._id + '/' + key, {encode: true, txn: ctx.txn}, function(err, data) {
              doc._attachments[key].data = data;

              if (++recv === attachments.length) {
                result = doc;
              }
            });
          });
        } else {
          if (doc._attachments){
            for (var key in doc._attachments) {
              doc._attachments[key].stub = true;
            }
          }
          result = doc;
        }

        call(callback, null, result);
      });
    });
  };

  api.get = function (id, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    if (opts.open_revs) {
      customApi._getRevisionTree(id, function(rev_tree){
        var leaves = [];
        if (opts.open_revs === "all") {
          leaves = collectLeaves(rev_tree).map(function(leaf){
            return leaf.rev;
          });
        } else {
          leaves = opts.open_revs; // should be some validation here
        }
        var result = [];
        var count = leaves.length;
        leaves.forEach(function(leaf){
          api.get(id, {rev: leaf}, function(err, doc){
            if (!err) {
              result.push({ok: doc});
            } else {
              result.push({missing: leaf});
            }
            count--;
            if(!count) {
              call(callback, null, result);
            }
          });
        });
      });
      return;
    }

    id = parseDocId(id);

    if (id.attachmentId !== '') {
      return customApi.getAttachment(id, callback);
    }

    customApi._genericGet(id, opts, function(err, result) {
      if(err) {
        return call(callback, err);
      }
      var doc = result;
      var metadata = result._metadata;
      delete result._metadata;

      if (opts.revs) { // FIXME: if rev is given it should return ids from root to rev (don't include newer)
        var path = arrayFirst(rootToLeaf(metadata.rev_tree), function(arr) {
          return arr.ids.indexOf(doc._rev.split('-')[1]) !== -1;
        });
        path.ids.reverse();
        doc._revisions = {
          start: (path.pos + path.ids.length) - 1,
          ids: path.ids
        };
      }
      if (opts.revs_info) { // FIXME: this returns revs for whole tree and should return only branch for winner
        doc._revs_info = metadata.rev_tree.reduce(function(prev, current) {
          return prev.concat(collectRevs(current));
        }, []);
      }
      if (opts.conflicts) {
        var conflicts = collectConflicts(metadata.rev_tree, metadata.deletions);
        if (conflicts.length) {
          doc._conflicts = conflicts;
        }
      }
      call(callback, null, doc);
    });
  };

  api.getAttachment = function(id, opts, callback) {
    if (opts instanceof Function) {
      callback = opts;
      opts = {};
    }
    if (typeof id === 'string') {
      id = parseDocId(id);
    }

    return customApi._getAttachment(id, opts, callback);
  };

  api.allDocs = function(opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    if ('keys' in opts) {
      if ('startkey' in opts) {
        call(callback, extend({
          reason: 'Query parameter `start_key` is not compatible with multi-get'
        }, Pouch.Errors.QUERY_PARSE_ERROR));
        return;
      }
      if ('endkey' in opts) {
        call(callback, extend({
          reason: 'Query parameter `end_key` is not compatible with multi-get'
        }, Pouch.Errors.QUERY_PARSE_ERROR));
        return;
      }
    }

    return customApi._allDocs(opts, callback);
  };

  api.changes = function(opts) {
    return customApi._changes(opts);
  };

  api.close = function(callback) {
    return customApi._close(callback);
  };

  api.info = function(callback) {
    return customApi._info(callback);
  };
  
  api.id = function() {
    return customApi._id();
  };
  
  api.type = function() {
    return (typeof customApi._type === 'function') ? customApi._type() : opts.adapter;
  };

  api.bulkDocs = function(req, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    if (!opts) {
      opts = {};
    }

    if (!req || !req.docs || req.docs.length < 1) {
      return call(callback, Pouch.Errors.MISSING_BULK_DOCS);
    }

    if (!Array.isArray(req.docs)) {
      return call(callback, Pouch.Errors.QUERY_PARSE_ERROR);
    }

    if (!('new_edits' in opts)) {
      opts.new_edits = true;
    }

    return customApi._bulkDocs(req, opts, callback);
  };

  /* End Wrappers */

  api.replicate = {};

  api.replicate.from = function (url, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    return Pouch.replicate(url, customApi, opts, callback);
  };

  api.replicate.to = function (dbName, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    return Pouch.replicate(customApi, dbName, opts, callback);
  };

  for (var j in api) {
    if (!customApi.hasOwnProperty(j)) {
      customApi[j] = api[j];
    }
  }
  return customApi;
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PouchAdapter;
}
