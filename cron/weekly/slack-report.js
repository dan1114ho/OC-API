import config from 'config';
import Promise from 'bluebird';
import moment from 'moment-timezone';
import _ from 'lodash';
import models from '../../server/models';
import activities from '../../server/constants/activities';
import slackLib from '../../server/lib/slack';
import expenseStatus from '../../server/constants/expense_status';
onlyExecuteInProdOnMondays();

const {
  Activity,
  Expense,
  Collective,
  Transaction
} = models;

const createdLastWeek = getTimeFrame('createdAt');
const updatedLastWeek = getTimeFrame('updatedAt');

const donation = {
  where: {
    OrderId: {
      $not: null
    },
    platformFeeInHostCurrency: {
      $gt: 0
    }
  }
};

const pendingExpense = { where: { status: expenseStatus.PENDING } };
const approvedExpense = { where: { status: expenseStatus.APPROVED } };
const rejectedExpense = { where: { status: expenseStatus.REJECTED } };
const paidExpense = { where : { status: expenseStatus.PAID } };

const excludeOcTeam = { where: {
  CollectiveId: {
    $not: 1 // OpenCollective collective
  }
} };

const lastWeekDonations = _.merge({}, createdLastWeek, donation, excludeOcTeam);
const lastWeekExpenses = _.merge({}, updatedLastWeek, excludeOcTeam);

const pendingLastWeekExpenses = _.merge({}, lastWeekExpenses, pendingExpense);
const approvedLastWeekExpenses = _.merge({}, lastWeekExpenses, approvedExpense);
const rejectedLastWeekExpenses = _.merge({}, lastWeekExpenses, rejectedExpense);
const paidLastWeekExpenses = _.merge({}, lastWeekExpenses, paidExpense);

const collectiveByCurrency = {
  plain: false,
  group: ['currency'],
  attributes: ['currency'],
  order: ['currency']
};

const stripeReceived = { where: { type: activities.WEBHOOK_STRIPE_RECEIVED } };
const paypalReceived = { where: { type: activities.WEBHOOK_PAYPAL_RECEIVED } };

const distinct = {
  plain: false,
  distinct: true
};

Promise.props({

  // Donation statistics

  donationCount: Transaction.count(lastWeekDonations),

  donationAmount: Transaction
    .aggregate('amount', 'SUM', _.merge({}, lastWeekDonations, collectiveByCurrency))
    .map(row => `${row.SUM/100} ${row.currency}`),

  stripeReceivedCount: Activity.count(_.merge({}, createdLastWeek, stripeReceived)),

  paypalReceivedCount: Activity.count(_.merge({}, createdLastWeek, paypalReceived)),

  // Expense statistics

  pendingExpenseCount: Expense.count(pendingLastWeekExpenses),

  approvedExpenseCount: Expense.count(approvedLastWeekExpenses),

  rejectedExpenseCount: Expense.count(rejectedLastWeekExpenses),

  paidExpenseCount: Expense.count(paidLastWeekExpenses),

  pendingExpenseAmount: Expense
    .aggregate('amount', 'SUM', _.merge({}, pendingLastWeekExpenses, collectiveByCurrency))
    .map(row => `${-row.SUM/100} ${row.currency}`),

  approvedExpenseAmount: Expense
    .aggregate('amount', 'SUM', _.merge({}, approvedLastWeekExpenses, collectiveByCurrency))
    .map(row => `${-row.SUM/100} ${row.currency}`),

  rejectedExpenseAmount: Expense
    .aggregate('amount', 'SUM', _.merge({}, rejectedLastWeekExpenses, collectiveByCurrency))
    .map(row => `${-row.SUM/100} ${row.currency}`),

  paidExpenseAmount: Expense
    .aggregate('amount', 'SUM', _.merge({}, paidLastWeekExpenses, collectiveByCurrency))
    .map(row => `${-row.SUM/100} ${row.currency}`),

  // Collective statistics

  activeCollectivesWithTransactions: Transaction
    .findAll(_.merge({attributes: ['CollectiveId'] }, updatedLastWeek, distinct, excludeOcTeam))
    .map(row => row.CollectiveId),

  activeCollectivesWithExpenses: Expense
    .findAll(_.merge({attributes: ['CollectiveId'] }, updatedLastWeek, distinct, excludeOcTeam))
    .map(row => row.CollectiveId),

  newCollectives: Collective
    .findAll(_.merge({}, { attributes: ['slug']}, createdLastWeek))
    .map(collective => collective.dataValues.slug)

}).then(results => {
  results.activeCollectiveCount = _.union(results.activeCollectivesWithTransactions, results.activeCollectivesWithExpenses).length
  const report = reportString(results);
  console.log(report);
  return slackLib.postMessage(report, config.slack.webhookUrl, { channel: config.slack.privateActivityChannel });
}).then(() => {
  console.log('Weekly reporting done!');
  process.exit();
}).catch(err => {
  console.log('err', err);
  process.exit();
});

/**
 * Heroku scheduler only has daily or hourly cron jobs, we only want to run
 * this script once per week on Monday (1). If the day is not Monday on production
 * we won't execute the script
 */
function onlyExecuteInProdOnMondays() {
  const today = new Date();
  if (process.env.NODE_ENV === 'production' && today.getDay() !== 1) {
    console.log('NODE_ENV is production and day is not Monday, script aborted!');
    process.exit();
  }
}

function getTimeFrame(propName) {
  const thisWeekStartRaw = moment()
    .tz('America/New_York')
    .startOf('isoWeek')
    .add(9, 'hours');
  const thisWeekStart = thisWeekStartRaw.format();
  const lastWeekStart = thisWeekStartRaw.subtract(1, 'week').format();

  return {
    where: {
      [propName]: {
        $gt: lastWeekStart,
        $lt: thisWeekStart
      }
    }
  };
}

function reportString(results) {
  return `Weekly activity summary (excluding OC team):
\`\`\`
* Donations:
  - ${results.donationCount} donations received${displayTotals(results.donationAmount)}
  - ${results.stripeReceivedCount} donations received via Stripe Webhook (only recurring)
  - ${results.paypalReceivedCount} donations received via PayPal
* Expenses:
  - ${results.pendingExpenseCount} pending expenses${displayTotals(results.pendingExpenseAmount)}
  - ${results.approvedExpenseCount} approved expenses${displayTotals(results.approvedExpenseAmount)}
  - ${results.rejectedExpenseCount} rejected expenses${displayTotals(results.rejectedExpenseAmount)}
  - ${results.paidExpenseCount} paid expenses${displayTotals(results.paidExpenseAmount)}
* Collectives:
  - ${results.activeCollectiveCount} active collectives
  - ${results.newCollectives.length} new collectives${displayCollectives(results.newCollectives)}
\`\`\``;
}

function displayTotals(totals) {
  if (totals.length > 0) {
    return ` totaling:\n    * ${totals.join('\n    * ').trim()}`;
  }
  return "";
}

function displayCollectives(collectives) {
  if (collectives.length > 0) {
    return `:\n    * ${collectives.join('\n    * ').trim()}`;
  }
  return "";
}
