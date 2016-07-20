module.exports = function(app) {

  /**
   * Controllers.
   */
  const cs = {};
  const controllers = [
    'activities',
    'donations',
    'expenses',
    'paymentmethods',
    'groups',
    'images',
    'middlewares',
    'paypal',
    'homepage',
    'profile',
    'notifications',
    'stripe',
    'subscriptions',
    'transactions',
    'users',
    'webhooks',
    'test',
    'connectedAccounts'
  ];

  /**
   * Exports.
   */
  controllers.forEach((controller) => {
    cs[controller] = require(`${__dirname}/${controller}`)(app);
  });

  return cs;

};
