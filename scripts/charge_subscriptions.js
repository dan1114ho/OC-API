import fs from 'fs';
import json2csv from 'json2csv';
import { ArgumentParser } from 'argparse';

import * as payments from '../server/lib/payments';
import emailLib from '../server/lib/email';
import { promiseSeq } from '../server/lib/utils';
import { sequelize } from '../server/models';
import {
  ordersWithPendingCharges,
  processOrderWithSubscription,
  updateNextChargeDate,
  updateChargeRetryCount,
  handleRetryStatus,
} from '../server/lib/subscriptions';

const REPORT_EMAIL = 'ops@opencollective.com';

// These field names are the ones returned by
// processOrderWithSubscription().
const csvFields = [
  'orderId',
  'subscriptionId',
  'amount',
  'from',
  'to',
  'status',
  'error',
  'retriesBefore',
  'retriesAfter',
  'chargeDateBefore',
  'chargeDateAfter',
  'nextPeriodStartBefore',
  'nextPeriodStartAfter'
];

/** Run the script with parameters read from the command line */
async function run(options) {
  const start = new Date;
  const orders = await ordersWithPendingCharges();
  vprint(options, `${orders.length} subscriptions pending charges. dryRun: ${options.dryRun}`);
  const data = [];
  await promiseSeq(orders, async (order) => {
    vprint(options,
           `order: ${order.id}, subscription: ${order.Subscription.id}, ` +
           `attempt: #${order.Subscription.chargeRetryCount}, ` +
           `due: ${order.Subscription.nextChargeDate}`);
    data.push(await processOrderWithSubscription(options, order));
  }, options.batchSize);

  if (data.length > 0) {
    json2csv({ data, fields: csvFields }, (err, csv) => {
      vprint(options, 'Writing the output to a CSV file');
      if (err) console.log(err);
      else fs.writeFileSync('charge_subscriptions.output.csv', csv);
    });
  } else {
    vprint(options, 'Not generating CSV file');
  }
  if (!options.dryRun) {
    vprint(options, 'Sending email report');
    await emailReport(start, orders, data);
  }
}

/** Send an email with details of the subscriptions processed */
async function emailReport(start, orders, data) {
  const icon = (err) => err ? '❌' : '✅';
  let issuesFound = false;
  let result = [`Total Subscriptions pending charges found: ${orders.length}`, ''];

  result = result.concat(data.map((i) => {
    if (i.status === 'failure') issuesFound = true;
    return ` ${i.status !== 'unattempted' ? icon(i.error) : ''} ` + [
      `order: ${i.orderId}`,
      `subscription: ${i.subscriptionId}`,
      `amount: ${i.amount}`,
      `from: ${i.from}`,
      `to: ${i.to}`,
      `status: ${i.status}`,
      `error: ${i.error}`,
    ].join(', ');
  }));

  const now = new Date;
  const end = now - start;
  result.push(`\n\nTotal time taken: ${end}ms`);
  const subject = `${icon(issuesFound)} Daily Subscription Report - ${now.toLocaleDateString()}`;
  return emailLib.sendMessage(REPORT_EMAIL, subject, '', { bcc: ' ', text: result.join('\n') });
}

/** Print `message` to console if `options.verbose` is true */
function vprint(options, message) {
  if (options.verbose) {
    console.log(message);
  }
}

/** Return the options passed by the user to run the script */
function parseCommandLineArguments() {
  const parser = new ArgumentParser({
    addHelp: true,
    description: 'Charge due subscriptions',
  });
  parser.addArgument(['-v', '--verbose'], {
    help: 'Verbose output',
    defaultValue: false,
    action: 'storeConst',
    constant: true,
  });
  parser.addArgument(['--notdryrun'], {
    help: "Pass this flag when you're ready to run the script for real",
    defaultValue: false,
    action: 'storeConst',
    constant: true,
  });
  parser.addArgument(['-b', '--batch_size'], {
    help: 'batch size to fetch at a time',
    defaultValue: 10
  });
  const args = parser.parseArgs();
  return {
    dryRun: !args.notdryrun,
    verbose: args.verbose,
    batchSize: args.batch_size || 100
  };
}

/** Kick off the script with all the user selected options */
async function entryPoint(options) {
  vprint(options, 'Starting to charge subscriptions');
  try {
    await run(options);
  } finally {
    await sequelize.close();
  }
  vprint(options, 'Finished running charge subscriptions');
}

/* Entry point */
entryPoint(parseCommandLineArguments());
