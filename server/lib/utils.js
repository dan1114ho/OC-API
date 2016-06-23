/**
 * Dependencies
 */
const Url = require('url');
const config = require('config');
const crypto = require('crypto');
const base64url = require('base64url');

/**
 * Private methods.
 */

/**
 * Encrypt with resetPasswordSecret
 */
const encrypt = (text) => {
  var cipher = crypto.createCipher('aes-256-cbc', config.keys.opencollective.resetPasswordSecret)
  var crypted = cipher.update(text, 'utf8', 'hex')
  crypted += cipher.final('hex');
  return crypted;
}

/**
 * Descript wih resetPasswordSecret
 */
const decrypt = (text) => {
  var decipher = crypto.createDecipher('aes-256-cbc', config.keys.opencollective.resetPasswordSecret)
  var dec = decipher.update(text,'hex','utf8')
  dec += decipher.final('utf8');
  return dec;
}

/**
 * Generate a secured token that works inside URLs
 * http://stackoverflow.com/a/25690754
 */
const generateURLSafeToken = size => base64url(crypto.randomBytes(size));

/**
 * Get current Url.
 */
const getRequestedUrl = (req) => {
  return `${req.protocol}://${req.get('Host')}${req.url}`;
};

/**
 * Add parameters to an url.
 */
const addParameterUrl = (url, parameters) => {
  var parsedUrl  = Url.parse(url, true);

  function removeTrailingChar(str, char) {
    if (str.substr(-1) === char) {
      return str.substr(0, str.length - 1);
    }

    return str;
  }

  parsedUrl.pathname = removeTrailingChar(parsedUrl.pathname, '/');

  delete parsedUrl.search; // Otherwise .search in used in place of .query
  for (var p in parameters) {
    var param = parameters[p];
    parsedUrl.query[p] = param;
  }

  return Url.format(parsedUrl);
};

/**
 * Pagination: from (offset, limit) to (page, per_page).
 */
const paginatePage = (offset, limit) => {
  return {
    page: Math.floor(offset / limit + 1),
    perPage: limit
  }
};

/**
 * Get links for pagination.
 */
const getLinks = (url, options) => {
  var page = options.page || paginatePage(options.offset, options.limit).page;
  var perPage = options.perPage || paginatePage(options.offset, options.limit).perPage;

  if (!page && !perPage)
    return null;

  var links = {
    next: addParameterUrl(url, {page: page + 1, per_page: perPage}),
    current: addParameterUrl(url, {page: page, per_page: perPage})
  };
  if (page > 1) {
    links.prev = addParameterUrl(url, {page: page - 1, per_page: perPage});
    links.first = addParameterUrl(url, {page: 1, per_page: perPage});
  }

  if (options.total) {
    var lastPage = Math.ceil(options.total / perPage);
    links.last = addParameterUrl(url, {page: lastPage, per_page: perPage});
    if (page >= lastPage)
      delete links.next;
  }

  return links;
};

/**
 * Get headers for pagination.
 */
const getLinkHeader = (url, options) => {
  var links = getLinks(url, options);
  var header = '';
  var k = 0;
  for (var i in links) {
    header += ((k !== 0) ? ', ' : '') + '<' + links[i] + '>; rel="' + i + '"'; // eslint-disable-line
    k += 1;
  }

  return header;
};

/**
 * We can generate our own plan ids with stripe, we will use a simple one for
 * now until we decide to make more complex plans. We will only take into account
 * the currency, interval and amount. It will have the following format
 *
 * 'USD-MONTH-1000'
 */
const planId = (plan) =>  {
  return [plan.currency, plan.interval, plan.amount].join('-').toUpperCase();
};

/**
 * Pagination offset: from (page,per_page) to (offset, limit).
 */
const paginateOffset = (page, perPage) => {
  return {
    offset: (page - 1) * perPage,
    limit: perPage
  }
};

/**
 * Try to find in which tier a backer falls into based on the tiers definition
 */
const getTier = (user, tiers) => {

  var defaultTier;
  switch(user.role) {
    case 'MEMBER':
      return 'contributor';
      break;
    case 'HOST':
      defaultTier = 'host';
      break;
   default:
      defaultTier = 'backer';
      break;
  }

  if(!tiers || !user.totalDonations) return defaultTier;

  // We order the tiers by start range DESC
  tiers.sort((a,b) => { return a.range[0] < b.range[0]; });

  // We get the first tier for which the totalDonations is higher than the minimum amount for that tier
  const tier = tiers.find((tier) => (user.totalDonations >= tier.range[0]));

  return (tier && tier.name) ? tier.name : defaultTier;

};

/*
 * Hacky way to do currency conversion on Leaderboard
 */

const generateFXConversionSQL = () => {

  // All data as of 3/11/16
  const fxConversion = [
    ['USD', 1.0],
    ['EUR', 0.90],
    ['GBP', 0.71],
    ['MXN', 17.70],
    ['SEK', 8.34],
    ['AUD', 1.32],
    ['INR', 66.97],
    ['CAD', 1.3]
  ];

  var sql = 'CASE ';
  sql += fxConversion.map(currency => `WHEN MAX(g.currency) = '${currency[0]}' THEN SUM(amount) / ${currency[1]}`).join('\n');
  sql += 'ELSE 0 END AS "amountInUSD"';

  return sql;
};


/**
 * Default host id, set this for new groups created through Github
 */

const defaultHostId = () => {
  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV  === 'staging') {
    return 40;
  }
  return 1;
}
/**
 * Export public methods.
 */
module.exports = {
  paginateOffset,
  getRequestedUrl,
  addParameterUrl,
  getLinks,
  generateURLSafeToken,
  getLinkHeader,
  planId,
  encrypt,
  getTier,
  decrypt,
  generateFXConversionSQL,
  defaultHostId
}
