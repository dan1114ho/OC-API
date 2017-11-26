/*
 * This script runs through a few checks and lets us know if something is off
 */

import models, { sequelize } from '../../server/models';
import emailLib from '../../server/lib/email';


const VERBOSE = true;
let result = '';
let start;

const done = (err) => {
  if (err) result = result.concat('err', err);
  result = result.concat("\n\nTotal time taken: ", new Date() - start, "ms")
  console.log(result);
  console.log('\ndone!\n');``
  const subject = `Daily ledger health report - ${(new Date()).toLocaleDateString()}`;
  return emailLib.sendMessage(
    'ops@opencollective.com', 
    subject, 
    '', {
      bcc: ' ',
      text: result
    })
    .then(process.exit)
    .catch(console.error)
}

const judgment = (value, goodFunc) => {
  if ((goodFunc && goodFunc(value)) || (!goodFunc && value === 0)) {
    return '✅'
  } else {
    return '❌'
  }
}

const header = (str) => {
  result = result.concat(`\n>>> ${str}\n`);
}

const subHeader = (str, value, goodFunc) => {
  result = result.concat(`\t${judgment(value, goodFunc)}  ${str}: ${value}\n`);
}

const verboseData = (values, mapFunction) => {
  const mapFunc = mapFunction || (o => o);
  if (VERBOSE && values.length > 0) {
    const slice = 5;
    const output = values.slice(0, slice).map(mapFunc);
    output.forEach(v => result = result.concat(`\t\t▫️ ${JSON.stringify(v)}\n`))
    if (values.length > 10) {
      result = result.concat(`\t\t... and ${values.length - slice} more`);
    }
  }
}

const checkHostsUserOrOrg = () => {

  header('Checking Hosts must be USER or ORG');

  const hostErrors = [];

  // Check that a Host is a User or an ORG
  return sequelize.query(`
    WITH hosts as (SELECT distinct("HostCollectiveId") from "Collectives")

    SELECT id, type, slug from "Collectives"
    WHERE id IN (SELECT * FROM hosts);
    `, { type: sequelize.QueryTypes.SELECT})
    .then(hostCollectives => {
      subHeader('Hosts found', hostCollectives.length, h => h > 0);
      return hostCollectives
    })
    .each(hostCollective => {
      if (hostCollective.type !== 'USER' && hostCollective.type !== 'ORGANIZATION') {
        hostErrors.push(hostCollective);
      }
    })
    .then(() => {
      subHeader('Hosts found with incorrect type', hostErrors.length);
      verboseData(hostErrors, h => Object.assign({slug: h.slug, type: h.type}));
    });
} 

// Ensure all Collectives are setup properly
const checkHostCollectives = () => {

  header('Checking Host Collectives')

  // Check that a collective is not setup to host itself or be it's own parentCollectiveId
  return models.Collective.findAll({
    where: {
      HostCollectiveId: {
        $col: 'id'
      }
    }
  })
  .then(selfReferencingHosts => {
    subHeader('Self-referencing Hosts found', selfReferencingHosts.length);
    verboseData(selfReferencingHosts, h => Object.assign({slug: h.slug, id: h.id}));
  })
}

const checkHostStripeAccount = () => {
  return sequelize.query(`
  WITH hosts AS 
    (SELECT DISTINCT("HostCollectiveId") AS id FROM "Collectives" c 
      WHERE "HostCollectiveId" IS NOT NULL)
    
  SELECT h.id FROM hosts h
  LEFT JOIN "ConnectedAccounts" ca ON (h.id = ca."CollectiveId")
  WHERE ca."CollectiveId" IS NULL
    `, { type: sequelize.QueryTypes.SELECT})
  .then(hostsWithoutStripe => {
    subHeader('Hosts without Stripe', hostsWithoutStripe.length);
    verboseData(hostsWithoutStripe, h => h.id)
  })
}

const checkUsersAndOrgs = () => {

  header('Checking USER and ORG Collectives');

  // Check that no User or ORG has a HostCollectiveId or ParentCollectiveId
  return models.Collective.findAll({
    where: {
      type: {
        $or: ['USER', 'ORGANIZATION']
      },
      HostCollectiveId: {
        $ne: null
      }
    }
  })
  .then(collectives => {
    subHeader('USER or ORGs found with HostCollectiveId', collectives.length);
    verboseData(collectives, c => Object.assign({slug: c.slug, HostCollectiveId: c.HostCollectiveId}));
  })
  // TODO: Check that no non-USER Collective is directly linked to a USER
  .then(() => models.User.findAll({
    attributes: ['CollectiveId']
  }))
  .then(userCollectives => models.Collective.findAll({
    where: {
      id: {
        $in: userCollectives.map(u => u.CollectiveId)
      },
      type: {
        $ne: 'USER'
      }
    }
  }))
  .then(improperlyLinkedCollectives => {
    subHeader('Non-User collectives that are linked to a USER', improperlyLinkedCollectives.length);
    verboseData(improperlyLinkedCollectives, c => Object.assign({id: c.id, slug: c.slug }));
  })
}

const checkMembers = () => {
  header('Checking Members table');

  return models.Member.findAll({
    where: {
      MemberCollectiveId: {
        $col: 'CollectiveId'
      }
    }
  })
  .then(circularMembers => {
    subHeader('Members with CollectiveId = MemberCollectiveId', circularMembers.length);
    verboseData(circularMembers, cm => cm.id);
  })
}

// Check orders
const checkOrders = () => {

  header('Check orders');

  // Check that FromCollectiveId on an Order matches all Transactions
  const brokenOrders = [];
  let orders, transactions;
  return sequelize.query(`
    SELECT id from "Orders"
    WHERE "deletedAt" is null AND "processedAt" is not null AND "CollectiveId" != 1
    `, { type: sequelize.QueryTypes.SELECT
    })
    .then(o => {
      orders = o;
      subHeader('orders found', orders.length, o => o > 0);
    })
    .then(() => sequelize.query(`
      SELECT distinct("FromCollectiveId"), "OrderId" from "Transactions"
      WHERE type LIKE 'CREDIT' AND "deletedAt" is null
      `, {
        type: sequelize.QueryTypes.SELECT
      }))
    .then(txns => {
      transactions = txns;
    })
    .then(() => orders)
    .each(order => {
      const fromCollectiveIds = transactions.filter(txn => txn.OrderId === order.id)
      if (fromCollectiveIds.length > 1) {
        brokenOrders.push(order)
      }
      return Promise.resolve();
    })
    .then(() => {
      subHeader('orders found with mismatched FromCollectiveId', brokenOrders.length);
      verboseData(brokenOrders, o => o.id);
    })
}

// Check expenses
const checkExpenses = () => {

  header('Check expenses');

  // Check that there are no expenses marked as "PAID" and without transaction entries
  return sequelize.query(`
    SELECT 
      e.id AS id
    FROM "Expenses" e
    LEFT JOIN "Transactions" t ON t."ExpenseId" = e.id
    WHERE e.status ILIKE 'paid' AND t.id IS NULL AND  e."deletedAt" IS NULL
    ORDER BY "ExpenseId" DESC, e."updatedAt"
    `, { type: sequelize.QueryTypes.SELECT
    })
    .then(expenses => {
      subHeader('Paid expenses found without transactions', expenses.length);
      verboseData(expenses, e => Object.assign({id: e.id}));
    })
}

// Check all transactions
const checkTransactions = () => {

  header('Checking Transactions...')

  // Check every transaction has a "FromCollectiveId"
  return models.Transaction.count({
    where: {
      FromCollectiveId: {
        $eq: null
      }
    }
  })
  .then(txsWithoutFromCollectiveId => {
    subHeader('Transactions without `FromCollectiveId`', txsWithoutFromCollectiveId);
  })

  // Check no transaction has same "FromCollectiveId" and "CollectiveId"
  .then(() => models.Transaction.findAll({
    where: {
      CollectiveId: {
        $col: 'FromCollectiveId'
      }
    }
  }))
  .then(circularTxs => {
    subHeader('Transactions with same source and destination', circularTxs.length)
    verboseData(circularTxs, t => Object.assign({id: t.id}));
  })

  // check no transactions without TransactionGroup
  .then(() => models.Transaction.count({
    where: {
      TransactionGroup: {
        $eq: null
      }
    }
  }))
  .then(txnsWithoutTransactionGroup => {
    subHeader('Transactions without `TransactionGroup`', txnsWithoutTransactionGroup)
  })

  // Check every Order has even number of entries
  .then(() => sequelize.query(`
    SELECT "OrderId" FROM "Transactions"
        WHERE "OrderId" IS NOT NULL and "deletedAt" is null
          GROUP BY "OrderId"
          HAVING COUNT(*) % 2 != 0 
    `, {type: sequelize.QueryTypes.SELECT}))
  .then(oddOrderIds => {
    subHeader('Orders with odd (not multiple of 2) number of transactions', oddOrderIds.length)
  })

  // Check every Expense has a double Entry
  .then(() => sequelize.query(`
    SELECT "ExpenseId" FROM "Transactions"
        WHERE "ExpenseId" IS NOT NULL and "deletedAt" is null
          GROUP BY "ExpenseId"
          HAVING COUNT(*) != 2 
    `, {type: sequelize.QueryTypes.SELECT}))
  .then(oddExpenseIds => {
    subHeader('Expenses with less than or more than 2 transactions', oddExpenseIds.length)
    verboseData(oddExpenseIds)
  })

  // Check all TransactionGroups have two entries, one CREDIT and one DEBIT
  .then(() => sequelize.query(`
    SELECT "TransactionGroup" FROM "Transactions"
        WHERE "TransactionGroup" IS NOT NULL and "deletedAt" is null
          GROUP BY "TransactionGroup"
          HAVING COUNT(*) != 2 
    `, {type: sequelize.QueryTypes.SELECT}))
  .then(oddTxnGroups => {
    subHeader('Transaction groups that are not pairs', oddTxnGroups.length)
    verboseData(oddTxnGroups)
  })

  // Check no transactions without either an Expense or Order
  .then(() => models.Transaction.findAll({
    where: {
      OrderId: {
        $eq: null
      },
      ExpenseId: {
        $eq: null
      }
    }
  }))
  .then(txnsWithoutOrderOrExpenses => {
    subHeader('Transactions without OrderId or ExpenseId', txnsWithoutOrderOrExpenses.length);
    // TODO: reenable when this count is lower than 600
    // if (VERBOSE)
    //  txnsWithoutOrderOrExpenses.map(t => Object.assign({id: t.id}));
  })

  // Check that various fees and amounts add up
  // TODO
}

const checkCollectiveBalance = () => {

  const brokenCollectives = [];
  header('Checking balance of each (non-USER, non-ORG) collective');
  return models.Collective.findAll({
    where: {
      $or: [{type: 'COLLECTIVE'}, {type: 'EVENT'}]
    }
  })
  .then(collectives => {
    subHeader('Collectives found', collectives.length, l => l > 0);
    return collectives;
  })
  .each(collective => {
    return collective.getBalance()
      .then(balance => {
        if (balance < 0) {
          brokenCollectives.push(collective)
        }
        return Promise.resolve();
      })
  })
  .then(() => {
    subHeader('Collectives with negative balance: ', brokenCollectives.length);
    verboseData(brokenCollectives, c => Object.assign({id: c.id, slug: c.slug}))
  })

}

const run = () => {
  console.log('\nStarting check_ledger_health script...')
  start = new Date();
  
  return checkHostsUserOrOrg()
  .then(() => checkHostCollectives())
  .then(() => checkHostStripeAccount())
  .then(() => checkUsersAndOrgs())
  .then(() => checkMembers())
  .then(() => checkOrders())
  .then(() => checkExpenses())
  .then(() => checkTransactions())
  .then(() => checkCollectiveBalance())
  .then(() => done())
  .catch(done)
}

run();