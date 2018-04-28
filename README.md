Moltres
=======

Moltres is a Discord bot for reporting, coordinating, and joining Pokemon Go
raids.  It was originally designed and written for [Valor of Boston](vob).

Moltres is location-agnostic and can be set up for use in any region.  It
performs best when its host server is outfitted with taggable regional roles,
so that it can use these roles to organize gyms and notify users of raid calls.

Setup
-----

To run an instance of Moltres for your Discord server, first clone the repo:

    git clone https://github.com/mxw/moltres.git

Next, install all the Node package dependencies.

    npm install mysql
    npm install discord.js  # discord.js@11.3.2
    # The rest are peer dependencies of discord.js:
    npm install bufferutil@^3.0.3
    npm install erlpack@discordapp/erlpack
    npm install node-opus@^0.2.7
    npm install opusscript@^0.0.6
    npm install sodium@^2.0.3
    npm install libsodium-wrappers@^0.7.3
    npm install uws@^9.14.0

Install MySQL, e.g.,

    sudo apt-get install mysql-server

and create a database `moltresdb` for use by a user named `moltres`.  Then,
create five tables: `gyms`, `raids`, `calls`, `rsvps`, and `permissions`:

    CREATE TABLE `gyms` (
      `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
      `handle` varchar(64) NOT NULL,
      `name` varchar(256) NOT NULL,
      `region` varchar(256) unsigned NOT NULL,
      `lat` decimal(10,8) NOT NULL,
      `lng` decimal(11,8) NOT NULL,
      `silent` tinyint(1) NOT NULL DEFAULT '0',
      PRIMARY KEY (`id`),
      UNIQUE KEY `handle` (`handle`),
      KEY `region` (`region`)
    ) ENGINE=InnoDB DEFAULT CHARSET=latin1;

    CREATE TABLE `raids` (
      `gym_id` int(10) unsigned NOT NULL,
      `tier` tinyint(3) unsigned NOT NULL,
      `boss` char(16) DEFAULT NULL,
      `despawn` timestamp NOT NULL,
      `spotter` bigint(20) unsigned NOT NULL,
      `team` enum('valor','mystic','instinct') DEFAULT NULL,
      PRIMARY KEY (`gym_id`),
      CONSTRAINT `raids_ibfk_1` FOREIGN KEY (`gym_id`) REFERENCES `gyms` (`id`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=latin1;

    CREATE TABLE `calls` (
      `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
      `raid_id` int(10) unsigned NOT NULL,
      `caller` bigint(20) unsigned NOT NULL,
      `time` timestamp NOT NULL,
      PRIMARY KEY (`id`),
      UNIQUE KEY `raid_id_2` (`raid_id`,`time`),
      KEY `raid_id` (`raid_id`),
      CONSTRAINT `calls_ibfk_1` FOREIGN KEY (`raid_id`) REFERENCES `raids` (`gym_id`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=latin1;

    CREATE TABLE `rsvps` (
      `call_id` int(10) unsigned NOT NULL,
      `user_id` bigint(20) unsigned NOT NULL,
      `extras` tinyint(3) unsigned NOT NULL DEFAULT '0',
      `maybe` tinyint(1) NOT NULL DEFAULT '0',
      PRIMARY KEY (`call_id`,`user_id`),
      CONSTRAINT `rsvps_ibfk_1` FOREIGN KEY (`call_id`) REFERENCES `calls` (`id`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=latin1

    CREATE TABLE `permissions` (
      `cmd` varchar(64) NOT NULL,
      `user_id` bigint(20) unsigned NOT NULL,
      PRIMARY KEY (`cmd`,`user_id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=latin1

Create a Discord bot account by following [these steps](discord-bot).  When
adding Moltres to your server, you must grant it the following permissions in
the channels in which it's active:
- Read Messages
- Send Messages
- Manage Messages
- Embed Links
- Read Message History
- Use External Emojis
- Add Reactions

Finally, add a file `config.js` in the repo's root directory with the following
structure:

    /*
     * config.js
     */
    module.exports = {
      moltres: "Discord login token for the bot user",
      moltresdb: "MySQL password for moltres",

      guild_id: 'Discord ID of your host server',

      admin_ids: new Set([
        // Array of Discord IDs of users considered bot admins.
      ]),

      channels: new Set([
        // Array of Discord IDs of text channels Moltres should watch.
      ]),
      log_id: 'Discord ID for the designated log channel',

      regions: {
        // Map from string region names to region role string IDs.
      },
      metaregions: {
        // Map from string meta-region names to array of constituent regions.
      },

      emoji: {
        // Map from Moltres's emoji names to custom emoji names available on
        // any of its servers.
        approved: '...',
        banned: '...',
        dealwithit: '...',
        valor: '...',
        mystic: '...',
        instinct: '...',
        raidegg: '...',
      }
    };

Usage
-----

To run Moltres, simply execute

    ./moltres.sh

once all the setup has been completed.  In order for Moltres to be useful,
you'll have to manually add gym records to the `gyms` table, either via MySQL
INSERT queries, or using the `$add-gym` command, e.g.,

    $add-gym galaxy-sphere kendall 42.362374 -71.084384 Galaxy: Earth Sphere

Contribution
------------

Feel free to submit issues or PRs for any bugs or feature requests you may
have.  Please be understanding of rejected feature requests---I am very
intentional about what capabilities to support with a system like this that
integrates with a social-first chat application.

If you're interested in Moltres development or have support questions, please
feel free to ask in [Victory Road](victory-road), Moltres's home server.


[vob]: https://www.valorofboston.com/
[discord-bot]: https://github.com/reactiflux/discord-irc/wiki/Creating-a-discord-bot-&-getting-a-token
[victory-road]: https://discord.gg/hTaVwwr
