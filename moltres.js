/*
 * Custom raid bot for Valor of Boston.
 */
'use strict';

const Discord = require('discord.js');
const mysql = require('mysql');
const config = require('./config.js');

const moltres = new Discord.Client();

moltres.on('ready', () => {
  console.log(`Logged in as ${moltres.user.tag}.`);
});

const conn = mysql.createConnection({
  host: 'localhost',
  user: 'moltres',
  password: config.moltresdb,
  database: 'moltresdb',
  supportBigNumbers: true,
  bigNumberStrings: true,
});

conn.connect(function(err) {
  if (err) {
    console.error(`Error connecting to moltresdb: ${err.stack}`);
    process.exit(1);
  }
  console.log(`Connected as id ${conn.threadId}.`);
});

///////////////////////////////////////////////////////////////////////////////

function cleanup() {
  moltres.destroy();
  conn.end();
}

function signal_handler(signal) {
  cleanup();
  process.exit(128 + signal);
}

process.on('exit', cleanup);
process.on('uncaughtException', cleanup);
process.on('SIGINT', signal_handler);
process.on('SIGHUP', signal_handler);
process.on('SIGTERM', signal_handler);
process.on('SIGABRT', signal_handler);

///////////////////////////////////////////////////////////////////////////////

const cmds = new Set([
  'gym', 'add-gym', 'edit-gym', 'rm-gym',
]);

const unrestricted_cmds = new Set([
  'gym',
]);

///////////////////////////////////////////////////////////////////////////////
// Discord utilities.

/*
 * Avoid polluting the rest of the file with emoji.
 */
const emoji = {
  no_good: '🙅',
};

/*
 * Get a custom emoji by name.
 */
function get_emoji(name) {
  return moltres.emojis.find('name', name);
}

/*
 * Count all the mentions in `msg'.
 */
function total_mentions(msg) {
  return msg.mentions.channels.size +
         msg.mentions.members.size +
         msg.mentions.roles.size +
         msg.mentions.users.size +
         msg.mentions.everyone;
}

/*
 * Log base function.
 */
function log_impl(msg, str, reacc) {
  if (str !== null) {
    let log = moltres.channels.get(config.log_id);
    log.send(str);
  }
  if (reacc !== null) {
    msg.react(reacc).catch(console.error);
  }
};

/*
 * Log a successful request, an invalid request, or an internal error.
 */
function log_success(msg, str, reacc = null) {
  log_impl(msg, str, reacc);
};
function react_success(msg, reacc = null) {
  log_impl(msg, null, reacc || get_emoji('approved'));
};
function log_invalid(msg, str, reacc = null) {
  log_impl(msg, str, reacc || emoji.no_good);
};
function log_error(msg, str, reacc = null) {
  log_impl(msg, str, reacc || emoji.no_good);
};

///////////////////////////////////////////////////////////////////////////////
// MySQL utilities.

/*
 * MySQL handler which logs any error, or otherwise delegates to a callback.
 */
function errwrap(fn = null) {
  return function (err, results, fields) {
    if (err) {
      console.error(e);
      return log_error(msg, `MySQL error: ${e.code}.`);
    }
    if (fn !== null) fn(results, fields);
  };
}

///////////////////////////////////////////////////////////////////////////////
// Gym handlers.

function handle_gym(msg, args) {
  const usage = 'Usage: gym <handle>';

  if (args.length !== 1) {
    return log_invalid(msg, usage);
  }
  let [handle] = args;

  conn.query(
    'SELECT * FROM gyms WHERE handle LIKE ?',
    [`%${handle}%`],

    errwrap(function (results, fields) {
      if (results.length !== 1) {
        return log_invalid(msg, `Multiple gyms matching ${handle}.`);
      }

      let [gym] = results;

      msg.channel.send(`\`[${gym.handle}]\`
name: **${gym.name}**
region: ${msg.guild.roles.get(gym.region).name}
coords: <https://maps.google.com/maps?q=${gym.lat},${gym.lng}>`
      ).then(m => {
        log_success(msg, `Handled \`gym\` from ${msg.author.tag}.`);
      }).catch(console.error);
    })
  );
}

function handle_add_gym(msg, args) {
  const usage = 'Usage: add-gym <handle> <region> <lat> <lng> <name>';

  if (args.length < 5 || total_mentions(msg) !== 1) {
    return log_invalid(msg, usage);
  }
  let [handle, region, lat, lng, ...name] = args;

  if (!region.match(Discord.MessageMentions.ROLES_PATTERN) ||
      msg.mentions.roles.size !== 1) {
    return log_invalid(msg, `Invalid region ${region}.`);
  }
  region = msg.mentions.roles.first().id;

  name = name.join(' ');

  conn.query(
    'INSERT INTO gyms SET ?',
    { handle: handle,
      name: name,
      region: region,
      lat: lat,
      lng: lng, },
    errwrap((..._) => react_success(msg))
  );
}

function handle_edit_gym(msg, args) {
  return false;
}

function handle_rm_gym(msg, args) {
  return false;
}

///////////////////////////////////////////////////////////////////////////////

/*
 * Do the work of `request'.
 */
function handle_request(msg, request, args) {
  switch (request) {
    case 'gym':       return handle_gym(msg, args);
    case 'add-gym':   return handle_add_gym(msg, args);
    case 'edit-gym':  return handle_edit_gym(msg, args);
    case 'rm-gym':    return handle_rm_gym(msg, args);
    default:
      return log_invalid(msg, `Invalid request ${request}.`);
  }
}

/*
 * Check whether the user who sent `msg' has the proper permissions to make
 * `request', and make it if so.
 */
function handle_request_with_check(msg, request, args) {
  let user_id = msg.author.id;

  if (!cmds.has(request)) return;

  if (config.admin_ids.has(user_id) ||
      unrestricted_cmds.has(request)) {
    return handle_request(msg, request, args);
  }

  conn.query(
    'SELECT * FROM permissions WHERE (cmd = ? AND user_id = ?)',
    [request, user_id],

    errwrap(function (results, fields) {
      if (results.length === 1) {
        return handle_request(msg, request, args);
      }

      return log_invalid(
        msg,
        `User ${msg.author.tag} does not have permissions for ${request}.`,
        get_emoji('dealwithit')
      );
    })
  );
}

/*
 * Process a user request.
 */
function process_request(msg) {
  let [prefix, request, ...rest] = msg.content.split(' ');

  if (prefix !== ':>') return;

  handle_request_with_check(msg, request, rest);
}

///////////////////////////////////////////////////////////////////////////////

/*
 * Main reader event.
 */
moltres.on('message', msg => {
  if (config.channels.has(msg.channel.id)) {
    try {
      process_request(msg);
    } catch (e) {
      console.error(e);
    }
  }
});

moltres.login(config.moltres);
