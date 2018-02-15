import LRUCache from 'lru-cache';

import { hashCode } from '../lib/utils';
import { EventEmitter } from 'events';
import debugLib from 'debug';
const debug = debugLib("cache");

const cache = LRUCache({
  max: 1000,
  maxAge: 1000 * 5 // in ms 
});

export default () => {
  /*
    use query and variables to identify a unique cache key
    Track active requests in process
    if incoming request matches an active request,
      wait for the active to finish and send the same response back to all 
      waiting requests that match cache key
  */

  // TODO: Need to write tests for this cache
  return (req, res, next) => {
    const temp = res.end;

    // only relevant for graphql queries, not mutations
    if (req.body && req.body.query && req.body.query.indexOf('mutation') === -1) {
      // important to include the user login token for checksum, so different users don't clash
      const token = req.headers && req.headers.authorization;
      const checksumString = `${JSON.stringify(req.body.query)}${JSON.stringify(req.body.variables)}${token}`;
      const checksum = hashCode(checksumString);
      req.checksum = checksum;

      let cached = cache.get(checksum);
      if (cached) {
        debug("cache hit", cached.status);
        switch (cached.status) {
          case 'finished':
            debug("sending response", cached.contentType, cached.response);
            res.setHeader("content-type", cached.contentType);
            return res.send(new Buffer(cached.response, "base64"));
          case 'running':
            return cached.once('finished', () => {
              return res.send(new Buffer(cached.response, "base64"));
            })
        }
      } else {
        cached = new EventEmitter();
        cached.status = 'running';
        cache.set(checksum, cached);
        req.cached = cached;
      }
    }

    res.end = function(data) {
      if (req.cached && req.checksum) {
        req.cached.status = 'finished';
        req.cached.response = data;
        if (typeof data === 'object') {
          req.cached.contentType = "application/json; charset=utf-8";
        }
        req.cached.emit('finished');
        debug("set cache", req.checksum, req.cached);
        cache.set(req.checksum, req.cached)
      }
      temp.apply(this,arguments);
    }
    next();
  }
};