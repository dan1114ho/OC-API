#!/usr/bin/env node
import '../server/env';

/**
 * This script subscribes all members of a collective (core contributors)
 * to the `user.yearlyreport` notification (for all collectives)
 */
import Promise from 'bluebird';
import models from '../server/models';

const debug = require('debug')('subscribe');

const { Notification, User } = models;

const processRows = rows => {
  return Promise.map(rows, processRow);
};

const init = () => {
  User.findAll()
    .then(processRows)
    .then(() => process.exit(0));
};

const processRow = row => {
  const type = 'user.yearlyreport';
  debug(`Subscribing UserId ${row.id} to ${type}`);

  return;

  /* Don't run this again because it would add duplicate rows
   * For some reason, the unique key on type,userid,collectiveid doesn't complain if collectiveid is null
  return Notification.create({
    UserId: row.id,
    type
  })
  .then(notification => console.log(`> UserId ${row.id} is now subscribed to ${type}`))
  .catch(() => console.error(`UserId ${row.id} already subscribed to ${type}`));
  */
};

init();
