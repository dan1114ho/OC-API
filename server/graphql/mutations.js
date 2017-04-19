import models from '../models';
import paymentsLib from '../lib/payments';
import emailLib from '../lib/email';
import responseStatus from '../constants/response_status';

import {
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';

import {
  EventType,
  ResponseType,
  TierType
} from './types';

import {
  EventInputType,
  ResponseInputType,
  TierInputType
} from './inputTypes';

// import { hasRole } from '../middleware/security/auth';
// import {HOST, MEMBER} from '../constants/roles';

const mutations = {
  createEvent: {
    type: EventType,
    args: {
      collectiveSlug: { type: new GraphQLNonNull(GraphQLString) },
      event: { type: EventInputType }
    },
    resolve(_, args) {
      const event = args.event;
      return models.Group.findOne({ where: { slug: args.collectiveSlug } })
      .then((group) => models.Event.create({
        ...event,
        GroupId: group.id
      }))
    }
  },
  updateEvent: {
    type: EventType,
    args: {
      event: { type: EventInputType }
    },
    resolve(_, args) {
      return models.Event.findById(args.event.id)
      .then(event => {
        if (!event) throw new Error(`Event with id ${args.event.id} not found`);
        return Event;
      })
      .then(event => event.update(args.event))
    }
  },
  createTier: {
    type: TierType,
    args: {
      collectiveSlug: { type: new GraphQLNonNull(GraphQLString) },
      eventSlug: { type: GraphQLString },
      tier: { type: TierInputType }
    },
    resolve(_, args) {
      const tier = args.tier;

      if (!args.eventSlug) {
        return models.Tier.create(tier);
      }

      let event;
      return models.Event.getBySlug(args.collectiveSlug, args.eventSlug)
      .then(e => event = e)
      .then(() => models.Tier.create({
        ...tier,
        EventId: event.id
      }))
    }
  },
  updateTier: {
    type: TierType,
    args: {
      tier: { type: TierInputType }
    },
    resolve(_, args) {
      return models.Tier.findById(args.tier.id)
      .then(tier => {
        if (!tier) throw new Error(`Tier with id ${args.tier.id} not found`);
        return tier;
      })
      .then(tier => tier.update(args.tier))
    }
  },
  createResponse: {
    type: ResponseType,
    args: {
      response: {
        type: ResponseInputType
      }
    },
    resolve(_, args) {

      let tier, user, event, responseModel, isPaidTier;
      const response = args.response;
      response.user.email = response.user.email.toLowerCase();

      const recordInterested = () => {
        return models.Event.getBySlug(response.group.slug, response.event.slug)
        .then(e => event = e)
        // find or create user
        .then(() => models.User.findOne({
          where: {
            $or: {
              email: response.user.email,
              paypalEmail: response.user.email
            }
          }
        }))
        .then(u => u || models.User.create(response.user))
        .tap(u => user = u)

        // create response
        .then(() => models.Response.create({
          UserId: user.id,
          GroupId: event.Group.id,
          EventId: event.id,
          confirmedAt: new Date(),
          status: response.status,
          description: response.description
        }));
      }

      const recordYes = () => {
        return models.Tier.findOne({
          where: {
            id: response.tier.id,
          },
          include: [{
            model: models.Event,
            where: {
              slug: response.event.slug
            },
            include: [{
              model: models.Group,
              where: {
                slug: response.group.slug
              }
            }]
          }]
        })
        .then(t => {
          if (!t) {
            throw new Error(`No tier found with tier id: ${response.tier.id} for event slug:${response.event.slug} in collective slug:${response.group.slug}`);
          }
          tier = t;
          event = t.Event;
          isPaidTier = tier.amount > 0;
        })

        // check for available quantity
        .then(() => tier.checkAvailableQuantity(response.quantity))
        .then(enoughQuantityAvailable => enoughQuantityAvailable ? 
              Promise.resolve() : Promise.reject(new Error(`No more tickets left for ${tier.name}`)))

        // make sure if it's paid tier, we have a card attached
        .then(() => isPaidTier && !(response.user.card && response.user.card.token) ? 
          Promise.reject(new Error(`This tier requires a payment method`)) : Promise.resolve())
        
        // find or create user
        .then(() => models.User.findOne({
          where: {
            $or: {
              email: response.user.email,
              paypalEmail: response.user.email
            }
          }
        }))
        .then(u => u || models.User.create(response.user))
        .tap(u => user = u)
        
        // create response
        .then(() => models.Response.create({
          UserId: user.id,
          GroupId: event.Group.id,
          EventId: event.id,
          TierId: tier.id,
          confirmedAt: isPaidTier ? null : new Date(),
          quantity: response.quantity || 0,
          status: response.status,
          description: response.description
        }))
        .tap(rm => responseModel = rm)

        // record payment, if needed
        .then(responseModel => {
          if (tier.amount > 0) {
            // also sends out email 
            return paymentsLib.createPayment({
              user,
              group: event.Group,
              response: responseModel,
              payment: {
                stripeToken: response.user.card.token,
                amount: tier.amount * responseModel.quantity,
                currency: tier.currency,
                description: `${event.name} - ${tier.name}`,
              }
            })
          } else {
            // only send out email if no payment
            return emailLib.send(
              'ticket.confirmed',
              user.email,
              { user: user.info,
                group: event.Group.info,
                response: responseModel.info,
                event: event.info,
                tier: tier && tier.info
              });
          }
        })
        .then(() => Promise.resolve(responseModel))
      }

      switch (response.status) {
        case responseStatus.INTERESTED:
          return recordInterested();

        case responseStatus.YES:
          return recordYes();
        
        default:
          throw new Error(`Unknown status ${response.status}`)
      }

    }
  }
}

export default mutations;