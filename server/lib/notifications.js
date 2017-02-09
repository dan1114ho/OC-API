import axios from 'axios';
import config from 'config';
import Promise from 'bluebird';

import activitiesLib from '../lib/activities';
import slackLib from './slack';
import {tweetActivity} from './twitter';
import emailLib from '../lib/email';
import activityType from '../constants/activities';

export default (Sequelize, activity) => {
  // publish everything to our private channel
  return publishToSlackPrivateChannel(activity)

    // publish a filtered version to our public channel
    .then(() => publishToSlack(activity, config.slack.webhookUrl,
      {
        channel: config.slack.publicActivityChannel
      }))
  
    // process certain types of notifications without a notification entry
    // like subscription cancellation emails
    // TODO: add donation confirmation emails to this flow as well.
    .then(() => {
      if (activity.type === activityType.SUBSCRIPTION_CANCELED) {
        return emailLib.sendMessageFromActivity(activity)
      }
      return Promise.resolve();
    })

    // process notification entries
    .then(() => {
      if (!activity.GroupId || !activity.type) {
        return Promise.resolve([]);
      }
      const where = {
        type: [
          activityType.ACTIVITY_ALL,
          activity.type
        ],
        channel: ['gitter', 'slack', 'twitter', 'email'],
        active: true
      };

      if (activity.type === activityType.GROUP_CREATED) {
        where.UserId = activity.data.host.id;
      } else {
        where.GroupId = activity.GroupId;
      }

      return Sequelize.models.Notification.findAll({
        include: {
          model: Sequelize.models.User,
          attributes: ['id', 'email']
        },
        where
      })
    })
    .then(notifConfigs =>
      Promise.map(notifConfigs, notifConfig => {
        if (notifConfig.channel === 'gitter') {
          return publishToGitter(activity, notifConfig);
        } else if (notifConfig.channel === 'slack') {
          return publishToSlack(activity, notifConfig.webhookUrl, {});
        } else if (notifConfig.channel === 'twitter') {
          return tweetActivity(Sequelize, activity);
        } else if (notifConfig.channel === 'email') {
          return emailLib.sendMessageFromActivity(activity, notifConfig);
        } else {
          return Promise.resolve();
        }
      }))
    .catch(err => {
      console.error(`Error while publishing activity type ${activity.type} for group ${activity.GroupId}`, err);
    });
};

function publishToGitter(activity, notifConfig) {
  const message = activitiesLib.formatMessageForPublicChannel(activity, 'markdown');
  if (message && process.env.NODE_ENV === 'production') {
    return axios.post(notifConfig.webhookUrl, { message });
  } else {
    Promise.resolve();
  }
}

function publishToSlack(activity, webhookUrl, options) {
  return slackLib.postActivityOnPublicChannel(activity, webhookUrl, options);
}

function publishToSlackPrivateChannel(activity) {
  return slackLib.postActivityOnPrivateChannel(activity);
}
