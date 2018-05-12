/*
 * MoltresBot config.js
 */
module.exports = {
  moltres: "DISCORD_BOT_TOKEN_GOES_HERE",
  moltresdb: "MYSQL_MOLTRESDB_USER_PASSWORD_GOES_HERE",

  guild_id: '123456789012345678', // Your Server (known as Guilds in the API) ID goes here

  admin_ids: new Set([
    // Array of Discord IDs of users considered bot admins.
	'123456789012345678',
	'223456789012345678'
  ]),

  channels: new Set([
    // Array of Discord IDs of text channels Moltres should watch.
	'323456789123456789',
	'423456789123456789'
  ]),
  log_id: '523456789123456789', // The channel for log output (e.g. #moltres_log)

  regions: {
    // Map from string region names to region role string IDs.
  },
  metaregions: {
    // Map from string meta-region names to array of constituent regions.
  },

  emoji: {
    // Map from Moltres's emoji names to custom emoji names available on
    // any of its servers.
    approved: '✅',
    banned: '⛔',
    dealwithit: '🕶',
    valor: 'valor',
    mystic: 'mystic',
    instinct: 'instinct',
    raidegg: '🥚',
  }
};

