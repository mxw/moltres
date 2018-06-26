/**
 * MySQL moltresdb boostrap script.
 */

CREATE USER 'moltres'@'localhost' IDENTIFIED BY 'YOUR_PASSWORD_IN_SINGLE_QUOTES';
-- To change password, replace CREATE USER with ALTER USER.
CREATE DATABASE moltresdb;
ALTER SCHEMA moltresdb DEFAULT CHARACTER SET utf8;
GRANT ALL PRIVILEGES ON moltresdb.* TO 'moltres'@'localhost';

USE moltresdb;

CREATE TABLE `gyms` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `handle` varchar(64) NOT NULL,
  `name` varchar(256) NOT NULL,
  `region` varchar(256) DEFAULT NULL,
  `lat` decimal(10,8) NOT NULL,
  `lng` decimal(11,8) NOT NULL,
  `ex` tinyint(1) NOT NULL DEFAULT '0',
  `silent` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `handle` (`handle`),
  KEY `region` (`region`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE `raids` (
  `gym_id` int(10) unsigned NOT NULL,
  `tier` tinyint(3) unsigned NOT NULL,
  `boss` char(16) DEFAULT NULL,
  `despawn` timestamp NOT NULL,
  `spotter` bigint(20) unsigned NOT NULL,
  `team` enum('valor','mystic','instinct') DEFAULT NULL,
  PRIMARY KEY (`gym_id`),
  CONSTRAINT `raids_ibfk_1` FOREIGN KEY (`gym_id`) REFERENCES `gyms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

 CREATE TABLE `calls` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `raid_id` int(10) unsigned NOT NULL,
  `caller` bigint(20) unsigned NOT NULL,
  `time` timestamp NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `raid_id_2` (`raid_id`,`time`),
  KEY `raid_id` (`raid_id`),
  CONSTRAINT `calls_ibfk_1` FOREIGN KEY (`raid_id`) REFERENCES `raids` (`gym_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE `rsvps` (
  `call_id` int(10) unsigned NOT NULL,
  `user_id` bigint(20) unsigned NOT NULL,
  `extras` tinyint(3) unsigned NOT NULL DEFAULT '0',
  `maybe` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`call_id`,`user_id`),
  CONSTRAINT `rsvps_ibfk_1` FOREIGN KEY (`call_id`) REFERENCES `calls` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE `permissions` (
  `cmd` varchar(64) NOT NULL,
  `user_id` bigint(20) unsigned NOT NULL,
  PRIMARY KEY (`cmd`,`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
