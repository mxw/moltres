/*
 * Async function wrappers around mysqljs.
 */
import * as mysql from 'mysql2/promise';

import { Result, OK, Err } from 'util/result'

///////////////////////////////////////////////////////////////////////////////

export type UpdateResult = mysql.OkPacket

export type QuerySuccess<T> = T extends mysql.OkPacket ? mysql.OkPacket : T[]
export type QueryError = mysql.QueryError & { sqlMessage?: string; }
export type QueryResult<T> = Result<QuerySuccess<T>, QueryError>


export class AsyncConnection {
  constructor(
    public conn: mysql.Connection,
    readonly config: mysql.ConnectionOptions,
  ) {}

  static async create(
    config: mysql.ConnectionOptions
  ): Promise<AsyncConnection> {
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
  async query<T>(
    sql_or_options: string | mysql.QueryOptions,
    values?: any | any[] | { [param: string]: any },
  ): Promise<QueryResult<T>> {
    try {
      // @ts-ignore
      const [result] = await this.conn.query(sql_or_options, values);
      return OK(result as QuerySuccess<T>);
    } catch (err) {
      if (err.code !== 'EPIPE' &&
          err.code !== 'PROTOCOL_CONNECTION_LOST') {
        return Err(err);
      }
      try {
        this.conn = await mysql.createConnection(this.config);
      } catch (_) {
        return Err(err);
      }
      return this.query(sql_or_options, values);
    }
  }

  /*
   * Gracefully close the connection, throwing an Error or resolving nullish.
   */
  end() { return this.conn.end(); }
}

export const connect = AsyncConnection.create;
export const format = mysql.format;
