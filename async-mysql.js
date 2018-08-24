/*
 * Async function wrappers around mysqljs.
 */
'use strict';

const mysql = require('mysql');

function AsyncConnection(conn) {
  this.conn = conn;
}

/*
 * Query the MySQL connection, and return a [result, error] tuple.
 *
 * As with mysqljs, we pass errors directly back to the client rather than
 * throwing exceptions, in the expectation that query failures are sometimes
 * non-exceptional conditions.
 */
AsyncConnection.prototype.query = function(...args) {
  return new Promise((resolve, reject) => {
    this.conn.query(...args, function (err, result) {
      resolve([result, err]);
    });
  });
};

/*
 * Gracefully close the connection, throwing an Error or resolving nullish.
 */
AsyncConnection.prototype.end = function() {
  return new Promise((resolve, reject) => {
    this.conn.end(function (err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

module.exports = {
  connect: function (config) {
    return new Promise((resolve, reject) => {
      let conn = mysql.createConnection(config);

      conn.connect(err => {
        if (err) {
          reject(err);
        } else {
          resolve(new AsyncConnection(conn));
        }
      });
    });
  },

  format: mysql.format,
};
