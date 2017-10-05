import url from 'url';
import Promise from 'bluebird';
import clearbit from '../gateways/clearbit';
import config from 'config';

export default {

  memory: {},

  clearbit,

  fetchAvatar(email) {
    return this.getUserData(email)
      .then(userData => userData && userData.avatar ? userData.avatar : null)
  },

  getUserData(email) {
    if (!config.clearbit || config.clearbit.match(/x+/)) return Promise.resolve();

    if (!email || !email.match(/.+@.+\..+/)) {
      return Promise.resolve();
    }

    if (this.memory[email] !== undefined) {
      return Promise.resolve(this.memory[email]);
    }

    return this.clearbit.Enrichment.find({email, stream: true})
      .tap(res => this.memory[email] = res.person)
      .then(res => res.person)
      .catch(clearbit.Enrichment.NotFoundError, () => this.memory[email] = null)
      .catch(err => console.error('Clearbit error', err));
  },

  resolveUserAvatars(userData, cb) {
    const { name } = userData;
    const { email } = userData;
    const { website } = userData;
    const { twitterHandle } = userData;
    let { linkedinUrl } = userData;
    let { facebookUrl } = userData;
    const { ip } = userData;

    if (!email || !email.match(/.+@.+\..+/)) {
      return cb(new Error("Invalid email"));
    }

    if (website) {
      const parsedWebsiteUrl = url.parse(website);
      const { hostname } = parsedWebsiteUrl;
      if (/facebook.com$/.test(hostname)) {
        facebookUrl = website;
      } else if (/linkedin.com\/pub|in|profile/.test(hostname)) {
        linkedinUrl = website;
      }
    }

    this.clearbit.Enrichment.find({
      email,
      given_name: name,
      ip_address: ip,
      linkedin: linkedinUrl,
      facebook: facebookUrl,
      twitter: twitterHandle,
      stream: true
    })
    .then((res) => {
      const { person } = res;
      const { company } = res;
      const sources = [];

      if (person) {
        const personAvatarSources = ['twitter', 'aboutme', 'grimage', 'github'];
        personAvatarSources.forEach((source) => {
          if (person[source] && person[source].image) {
            sources.push({src: person[source].image, source});
          }
        });
        if (person.image) {
          sources.push({src: person.image, source: 'clearbit'});
        }
      }

      if (company) {
        const companyAvatarSources = ['twitter', 'angellist'];
        companyAvatarSources.forEach((source) => {
          if (company[source] && company[source].image) {
            sources.push({src: company[source].image, source});
          }
        });
        if (company.image) {
          sources.push({src: company.image, source: 'clearbit'});
        }
      }

      return cb(null, sources);
    })
    .catch(clearbit.Enrichment.NotFoundError, () => {
      return cb(new clearbit.Enrichment.NotFoundError());
    })
    .catch((err) => {
      console.error('Clearbit error', err);
      return cb(err);
    });
  },

  /*
   * Extract username from github image url
   * Needed to get usernames for github signups
   */ 
  getUsernameFromGithubURL(url) {
    const githubUrl = 'images.githubusercontent.com/';
    if (url && url.indexOf(githubUrl) !== -1) {
      const tokens = url.split(githubUrl);
      if (tokens.length === 2 && tokens[1] !== '') {
        return tokens[1];
      }
    }
    return null;
  },

  updateUserInfoFromClearbit(user) {
    if (!user.email) {
      return Promise.resolve();
    } 
    return this.getUserData(user.email)
      .then(userData => {
        if (userData) {
          user.firstName = user.firstName || userData.name.givenName;
          user.lastName = user.lastName || userData.name.familyName;
          user.image = user.image || userData.image;
          user.twitterHandle = user.twitterHandle || userData.twitter.handle;
          user.website = user.website || userData.site;
          return user.save();
        } else {
          return Promise.resolve();
        }
      });
  }
};
