import {
  GraphQLInt,
  GraphQLList,
  GraphQLInputObjectType,
  GraphQLNonNull,
  GraphQLString,
  GraphQLScalarType,
  GraphQLError
} from 'graphql';

import { Kind } from 'graphql/language';

const EmailType = new GraphQLScalarType({
    name: 'Email',
    serialize: value => {
      return value;
    },
    parseValue: value => {
      return value;
    },
    parseLiteral: ast => {
      if (ast.kind !== Kind.STRING) {
        throw new GraphQLError(`Query error: Can only parse strings got a: ${ast.kind}`);
      }

      // Regex taken from: http://stackoverflow.com/a/46181/761555
      const re = /^([\w-]+(?:\.[\w-]+)*)@((?:[\w-]+\.)*\w[\w-]{0,66})\.([a-z]{2,6}(?:\.[a-z]{2})?)$/i;
      if (!re.test(ast.value)) {
        throw new GraphQLError(`Query error: Not a valid Email ${[ast]}`);
      }

      return ast.value;
    }
});

export const CardInputType = new GraphQLInputObjectType({
  name: 'CardInputType',
  description: 'Input type for Card',
  fields: () => ({
    token: { type: new GraphQLNonNull(GraphQLString)},
    expMonth: { type: new GraphQLNonNull(GraphQLInt)},
    expYear: { type: new GraphQLNonNull(GraphQLInt)},
    number: { type: new GraphQLNonNull(GraphQLInt)}
  })
});

export const UserInputType = new GraphQLInputObjectType({
  name: 'UserInputType',
  description: 'Input type for UserType',
  fields: () => ({
      id: { type: GraphQLInt },
      email: { type: new GraphQLNonNull(EmailType) },
      firstName: { type: GraphQLString },
      lastName: { type: GraphQLString },
      name: { type: GraphQLString },
      avatar: { type: GraphQLString },
      username: { type: GraphQLString },
      description: { type: GraphQLString },
      twitterHandle: { type: GraphQLString },
      website: { type: GraphQLString },
      paypalEmail: { type: GraphQLString },
      card: { type: CardInputType }
  })
});

export const GroupInputType = new GraphQLInputObjectType({
  name: 'GroupInputType',
  description: 'Input type for GroupType',
  fields: () => ({
    id:   { type: GraphQLInt },
    slug: { type: new GraphQLNonNull(GraphQLString) }
  })
});

export const EventAttributesInputType = new GraphQLInputObjectType({
  name: 'EventAttributes',
  description: 'Input type for attributes of EventInputType',
  fields: () => ({
    id: { type: GraphQLInt },
    slug: { type: GraphQLString },
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    locationString: { type: GraphQLString },
    startsAt: { type: GraphQLString },
    endsAt: { type: GraphQLString },
    maxAmount: { type: GraphQLInt },
    currency: { type: GraphQLString},
  })
});

export const EventInputType = new GraphQLInputObjectType({
  name: 'EventInputType',
  description: 'Input type for EventType',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: new GraphQLNonNull(GraphQLString) },
    locationString: { type: GraphQLString },
    startsAt: { type: new GraphQLNonNull(GraphQLString) },
    endsAt: { type: GraphQLString },
    maxAmount: { type: new GraphQLNonNull(GraphQLString) },
    currency: { type: GraphQLString },
    quantity: { type: GraphQLInt },
    tiers: { type: new GraphQLList(TierInputType) },
    group: { type: new GraphQLNonNull(GroupInputType) },
  })
});

export const TierInputType = new GraphQLInputObjectType({
  name: 'TierInputType',
  description: 'Input type for TierType',
  fields: () => ({
    id: { type: GraphQLInt },
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    amount: { type: GraphQLInt },
    currency: { type: GraphQLString },
    quantity: { type: GraphQLInt },
    password: { type: GraphQLString },
    startsAt: { type: GraphQLString },
    endsAt: { type: GraphQLString },
  })
});

export const ResponseInputType = new GraphQLInputObjectType({
  name: 'ResponseInputType',
  description: 'Input type for ResponseType',
  fields: () => ({
    quantity: { type: GraphQLInt },
    user: { type: new GraphQLNonNull(UserInputType) },
    group: { type: new GraphQLNonNull(GroupInputType) },
    tier: { type: TierInputType },
    event: { type: new GraphQLNonNull(EventAttributesInputType) },
    status: { type: new GraphQLNonNull(GraphQLString) }
  })
});