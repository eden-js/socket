
// Require dependencies
const io   = require('socket.io-client');
const uuid = require('uuid');

// Require local dependencies
const store = require('core/public/js/store');

/**
 * Build socket class
 */
class SocketStore {
  /**
   * Construct socket class
   */
  constructor() {
    // Set variables
    this.__userID = store.get('user') && store.get('user').get ? store.get('user').get('id') : (store.get('user') || {}).id;

    // Bind private methods
    this.call = this.call.bind(this);
    this.user = this.user.bind(this);
    this.build = this.build.bind(this);
    this.route = this.route.bind(this);

    // set building
    this.building = this.build();
  }

  /**
   * build socket store
   *
   * @return {Promise}
   */
  async build() {
    // Run socket
    this.socket = io.connect(store.get('config').socket.url, store.get('config').socket.params);

    // socket on
    this.socket.on('connect', () => {
      // true
      this.connected = true;
    }).on('disconnect', () => {
      // false
      this.connected = false;
    });

    // Bind methods
    this.on = this.socket.on.bind(this.socket);
    this.off = this.socket.off.bind(this.socket);
    this.emit = this.socket.emit.bind(this.socket);
    this.once = this.socket.once.bind(this.socket);

    // Pre user
    store.pre('set', (data) => {
      // Check key
      if (data.key !== 'socket') return;

      // Set val
      data.val = this;
    });

    // Listen to route
    this.on('user', this.user);

    // Store on user
    store.on('user', this.user);
  }

  /**
   * Calls name and data
   *
   * @param  {String} name
   * @params {*} args
   *
   * @return {Promise}
   */
  async call(name, ...args) {
    // Let id
    const id = uuid();

    // Create emission
    const emission = {
      id,
      args,
      name,
    };

    // Emit to socket
    this.emit('eden.call', emission);

    // Await one response
    const result = await new Promise((resolve) => {
      // On message
      this.once(id, resolve);
    });

    // Return result
    return result;
  }

  /**
   * Calls name and data
   *
   * @param  {String} route
   * @param  {Object} opts
   *
   * @return {Promise}
   */
  async route(method, path, opts = {}) {
    // check body
    const { query, body } = opts;

    // Let id
    const id = uuid();

    // Create emission
    const emission = {
      id,
      path,
      method,
      body  : body || {},
      query : query || {},
    };

    // Emit to socket
    this.emit('eden.route', emission);

    // Await one response
    const result = await new Promise((resolve) => {
      // On message
      this.once(id, resolve);
    });

    // Return result
    return result;
  }

  /**
   * Listen to state change
   *
   * @param {Object} user
   *
   * @return {*}
   */
  user(user) {
    // check user id
    if ((!user && this.__userID) || (user.get ? user.get('id') : user.id) !== this.__userID) {
      // set user id
      this.__userID = user ? (user.get ? user.get('id') : user.id) : null;

      // reset connection
      this.socket.disconnect();
      this.socket.connect();
    }
  }
}

/**
 * Export built socket class
 *
 * @type {SocketStore}
 */
exports = module.exports = window.eden.socket = new SocketStore();
