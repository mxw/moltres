/*
 * MoltresBot config.js
 */
module.exports = {
  moltres: "DISCORD_BOT_LOGIN_TOKEN",
  moltresdb: "MYSQL_MOLTRESDB_USER_PASSWORD",

  // All Discord IDs are ~18 digit integers given as strings, e.g.,
  // '663943454550151362'.  All the IDs below are randomly generated.

  // Discord ID of your host server.
  guild_id: '363943454550151362',

  // Array of Discord IDs of users considered bot admins.
  admin_ids: new Set([
    '203901392075299070',
  ]),

  // Map from Discord IDs of text channels Moltres watches to arrays of region
  // or metaregion names whose raid activities should be posted to the channel.
  channels: {
    // Raid reports and calls for Foobar Square and Baz University are posted
    // in this channel.
    '360364029619318505': ['Foobar Square', 'Baz University'],
    // Another way of expressing the same thing as the above (because of the
    // Downtown metaregion definition below.
    '360364029619318505': ['Downtown'],

    // Moltres watches this channel but doesn't post to it.
    '406619804973474187': [],
  },
  // Discord ID of the designated log channel, e.g., #moltres_log.
  log_id: '302810502352155064',

  // Map from string region names to region role string IDs.
  regions: {
    'Foobar Square': '217411278013305715',
    'Baz University': '375010432273546672',
  },
  // Map from string meta-region names to array of constituent regions.
  metaregions: {
    'Downtown': ['Foobar Square', 'Baz University'],
  },
  // Name of the geographic area your server encompasses.
  area: 'Metropolis',

  // Map from Moltres's emoji names to custom emoji names or supported Discord
  // emoji available on any of its servers.
  emoji: {
    approved: '✅',
    banned: '⛔',
    dealwithit: '🕶',
    team: 'valor',
    valor: 'valor',
    mystic: 'mystic',
    instinct: 'instinct',
    raidegg: '🥚',
    boss: '🐳',
  }
};
