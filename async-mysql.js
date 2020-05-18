/*
 * Async function wrappers around mysqljs.
 */
'use strict';

const mysql = require('mysql2/promise');

class AsyncConnection {
  constructor(conn, config) {
    this.conn = conn;
    this.config = config;
  }

  static async create(config) {
    const conn = await mysql.createConnection(config);
    return new AsyncConnection(conn, config);
  }

  /*
   * Query the MySQL connection, and return a [result, error] tuple.
   *
   * As with mysqljs, we pass errors directly back to the client rather than
   * throwing exceptions, in the expectation that query failures are sometimes
   * non-exceptional conditions.
   */
  async query(...args) {
    try {
      const [result] = await this.conn.query(...args);
      return [result, null];
    } catch (err) {
      if (err.code !== 'EPIPE' &&
          err.code !== 'PROTOCOL_CONNECTION_LOST') {
        return [null, err];
      }
      try {
        this.conn = await mysql.createConnection(this.config);
      } catch (_) {
        return [null, err];
      }
      return this.query(...args);
    }
  }

  /*
   * Gracefully close the connection, throwing an Error or resolving nullish.
   */
  end() { return this.conn.end(); }
}

module.exports = {
  connect: AsyncConnection.create,
  format: mysql.format,
};
