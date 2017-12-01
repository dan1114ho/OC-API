import fs from 'fs';
import handlebars from './handlebars';

/*
* Loads all the email templates
*/

const templates = {};

const templateNames = [
  'announcement',
  'announcement.text',
  'user.monthlyreport',
  'user.monthlyreport.text',
  'email.approve',
  'email.message',
  'github.signup',
  'collective.confirm',
  'collective.created',
  'collective.expense.approved.for.host',
  'collective.expense.created',
  'collective.expense.paid',
  'collective.order.created',
  'collective.monthlyreport',
  'collective.monthlyreport.text',
  'collective.newmember',
  'host.monthlyreport',
  'host.monthlyreport.text',
  'host.monthlyreport.summary',
  'processing',
  'subscription.canceled',
  'ticket.confirmed',
  'ticket.confirmed.sustainoss',
  'thankyou',
  'thankyou.sustain',
  'thankyou.wwcode',
  'thankyou.kendraio',
  'thankyou.brusselstogether',
  'thankyou.ispcwa',
  'thankyou.fr',
  'thankyou.laprimaire',
  'user.forgot.password',
  'user.new.token',
  'user.yearlyreport',
  'user.yearlyreport.text'
];

const templatesPath = `${__dirname}/../../templates`;

// Register partials
const header = fs.readFileSync(`${templatesPath}/partials/header.hbs`, 'utf8');
const footer = fs.readFileSync(`${templatesPath}/partials/footer.hbs`, 'utf8');
const footertxt = fs.readFileSync(`${templatesPath}/partials/footer.text.hbs`, 'utf8');
const subscriptions = fs.readFileSync(`${templatesPath}/partials/subscriptions.hbs`, 'utf8');
const toplogo = fs.readFileSync(`${templatesPath}/partials/toplogo.hbs`, 'utf8');
const relatedcollectives = fs.readFileSync(`${templatesPath}/partials/relatedcollectives.hbs`, 'utf8');
const collectivecard = fs.readFileSync(`${templatesPath}/partials/collectivecard.hbs`, 'utf8');
const chargeDateNotice = fs.readFileSync(`${templatesPath}/partials/charge_date_notice.hbs`, 'utf8');
const mthReportFooter = fs.readFileSync(`${templatesPath}/partials/monthlyreport.footer.hbs`, 'utf8');
const mthReportSubscription= fs.readFileSync(`${templatesPath}/partials/monthlyreport.subscription.hbs`, 'utf8');

handlebars.registerPartial('header', header);
handlebars.registerPartial('footer', footer);
handlebars.registerPartial('footer.text', footertxt);
handlebars.registerPartial('subscriptions', subscriptions);
handlebars.registerPartial('toplogo', toplogo);
handlebars.registerPartial('collectivecard', collectivecard);
handlebars.registerPartial('relatedcollectives', relatedcollectives);
handlebars.registerPartial('charge_date_notice', chargeDateNotice);
handlebars.registerPartial('mr-footer', mthReportFooter);
handlebars.registerPartial('mr-subscription', mthReportSubscription);

templateNames.forEach((template) => {
  const source = fs.readFileSync(`${templatesPath}/emails/${template}.hbs`, 'utf8');
  templates[template] = handlebars.compile(source);
});

export default templates;
