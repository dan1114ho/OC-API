#!/usr/bin/env node

'use strict';

const app = require('../index');
const GitHubClient = require('opencollective-jobs').GitHubClient;
const Group = app.set('models').Group;
const _ = require('lodash');

const client = GitHubClient({logLevel: 'verbose'});

Group.findAll({
  attributes: [
    'id',
    'name',
    'slug',
    'settings'
  ]
})
  .each(group => {
    const org = _.get(group, 'settings.githubOrg', group.slug);
    return client.contributorsInOrg({orgs: [org]})
      .get(org)
      .then(perRepo => {
        return _(perRepo)
          .map('contributors')
          .reduce((acc, contributions) => {
            _.each(contributions, (count, user) => {
              acc[user] = (acc[user] || 0) + count;
            });
            return acc;
          }, {});
      })
      .then(contributorData => {
        group.settings = _.assign(group.settings || {}, {
          githubOrg: org
        });
        group.data = _.assign(group.data || {}, {
          githubContributors: contributorData
        });
        return group.save();
      })
      .then(() => {
        console.log(`Successfully updated contribution data for group "${group.name}"`);
      })
      .catch(err => {
        console.log(`WARNING: ${err.message}`);
      })
  })
  .finally(() => {
    process.exit();
  });
