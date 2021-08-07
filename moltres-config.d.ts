declare module 'moltres-config'
/*
 * Configuration format for Moltres.
 *
 * To configure Moltres, create a `moltres-config.js` file in the toplevel
 * directory (as a sibling of this file) conforming to this declaration.  The
 * canonical way to do this is to write:
 *
 * module.exports = {
 *   moltres: "YOUR_LOGIN_TOKEN",
 *   dbname: "YOUR_DB_NAME",
 *   // everything else specified here
 * };
 */

import * as Discord from 'discord.js';

///////////////////////////////////////////////////////////////////////////////

/*
 * Discord bot login token.
 */
declare const moltres: string;

/*
 * MySQL parameters.
 */
declare const dbname: string; // default: moltresdb
declare const dbuser: string; // default: moltres
declare const dbpass: string;

/*
 * Array of Discord IDs of users considered bot admins.
 *
 * @see: https://discord.js.org/#/docs/main/stable/typedef/Snowflake
 */
declare const admin_ids: Set<Discord.Snowflake>;

///////////////////////////////////////////////////////////////////////////////

/*
 * Discord ID of the host server.
 */
declare const guild_id: Discord.Snowflake;

/*
 * Discord ID of the designated log channel, e.g., #moltres_log.
 */
declare const log_id: Discord.Snowflake;

/*
 * Map from Discord IDs of text channels Moltres watches to arrays of region or
 * metaregion names whose raid activities should be posted to the channel.
 *
 * An example channel config:
 *
 *  channels: {
 *    // Raid reports and calls for Foobar Square and Baz University are posted
 *    // in this channel.
 *    '360364029619318505': ['Foobar Square', 'Baz University'],
 *    // Another way of expressing the same thing as the above (because of the
 *    // Downtown metaregion example definition below).
 *    '360364029619318505': ['Downtown'],
 *
 *    // Moltres watches this channel but doesn't post to it.
 *    '406619804973474187': [],
 *  },
 */
declare const channels: Record<Discord.Snowflake, string[]>;

///////////////////////////////////////////////////////////////////////////////

/*
 * Name of the geographic area your server encompasses.
 */
declare const area: string;

/*
 * Map from string region names to region role string IDs.  Optional for each
 * region.
 *
 * An example region config:
 *
 *  regions: {
 *    'Foobar Square': '217411278013305715',
 *    'Baz University': '375010432273546672',
 *  },
 */
declare const regions: Record<string, Discord.Snowflake>;

/*
 * Map from string meta-region names to array of constituent regions.  Not all
 * regions need to be contained in metaregions, and a region can belong to
 * multiple metaregions.
 *
 * An example metaregion config:
 *
 *  metaregions: {
 *    'Downtown': ['Foobar Square', 'Baz University'],
 *  },
 */
declare const metaregions: Record<string, string[]>;

/*
 * Map from string region or metaregion names to tz database name override.
 *
 * An example timezone config:
 *
 *  timezones: {
 *    'Downtown': 'America/Los_Angeles',
 *  },
 */
declare const timezones: Record<string, string>;

/*
 * Default tz database time zone name.
 */
declare const tz_default: string;

///////////////////////////////////////////////////////////////////////////////

/*
 * How long in minutes before a raid begins should Moltres send an alarm
 * message?  To omit the alarm, set to null.
 */
declare const raid_alarm: number | null;

/*
 * Function which returns whether raid call times should be revealed in
 * response to `msg', with `guild' corresponding to guild_id.  Can be null (or
 * unset) to skip the check.
 *
 * For example, to hide call times in DMs, you could do:
 *
 * module.exports = {
 *   // ...
 *   call_check: (msg, guild) => msg.channel.type !== 'dm';
 * }
 */
declare const call_check:
  (msg: Discord.Message, guild: Discord.Guild) => boolean | null;

/*
 * EX raid room configuration.
 */
declare const ex: {
  /*
   * Channels to listen for EX-related requests in.
   */
  channels: Set<Discord.Snowflake>,

  /*
   * Discord ID of the EX raid room channel category.
   *
   * This is an optional parameter; if it isn't provided, the EX channels will
   * not belong to any category.  Note, however, that in this case, channels
   * with names that resemble EX raid room names will confuse Moltres.
   */
  category?: Discord.Snowflake,

  /*
   * Array of permission overwrite objects.  By default, the only permission
   * overwrite for the channel will be that @everyone cannot read messages.
   * See the discord.js documentation for more details about the structure of
   * this array.
   *
   * Moltres uses the existence of permission overwrites for a specific user as
   * an indicator of whether the user is present in the room, so be careful of
   * adding user-specific overwrites here.
   *
   * @see: https://discord.js.org/#/docs/main/stable/typedef/ChannelCreationOverwrites
   */
  permissions: (Discord.OverwriteData & {id: Discord.Snowflake})[],

  /*
   * Whether to ban $exit on the day of the EX raid to encourage good
   * communication.
   */
  exit_strict: boolean,
};

///////////////////////////////////////////////////////////////////////////////

type EmojiAlias =
    'approved'
  | 'banned'
  | 'dealwithit'
  | 'rollsafe'
  | 'join'
  | 'team'
  | 'valor'
  | 'mystic'
  | 'instinct'
  | 'raidegg'
  | 'boss'

/*
 * Map from Moltres's emoji aliases (above) to any of:
 *  - Unicode emoji literals
 *  - name of an emoji listed in src/util/emoji.ts
 *  - name of any custom server emoji in any server your bot roosts in
 */
declare const emoji: Record<EmojiAlias, string>;

/*
 * Map from boss nicknames to full names.
 */
declare const boss_aliases: Record<string, string>;
