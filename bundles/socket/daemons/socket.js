
// Require dependencies
const uuid         = require('uuid');
const fetch        = require('node-fetch');
const config       = require('config');
const Daemon       = require('daemon');
const session      = require('express-session');
const passport     = require('passport.socketio');
const socketio     = require('socket.io');
const RedisStore   = require('connect-redis')(session);
const cookieParser = require('cookie-parser');

// Require cache dependencies
const calls = cache('calls');

// Require helpers
const aclHelper = helper('user/acl');

/**
 * Build socket daemon
 *
 * @express
 */
class SocketDaemon extends Daemon {
  /**
   * Construct socket daemon
   */
  constructor() {
    // Run super
    super();

    // Don't run on router thread if no server is applicable
    if (!this.eden.router) return;

    // Bind variables
    this.__socketIO = false;
    this.__connections = {
      users    : new Map(),
      sockets  : new Map(),
      sessions : new Map(),
    };

    // Bind methods
    this.build = this.build.bind(this);

    // on connect
    this.onConnect = this.onConnect.bind(this);
    this.onDisconnect = this.onDisconnect.bind(this);

    // count methods
    this.countConnections = this.countConnections.bind(this);

    // Bind private methods
    this.call = this.call.bind(this);
    this.emit = this.emit.bind(this);
    this.user = this.user.bind(this);
    this.route = this.route.bind(this);
    this.session = this.session.bind(this);

    // Build
    if (config.get('socket')) this.build();
  }


  // ////////////////////////////////////////////////////////////////////////////
  //
  // BUILD METHODS
  //
  // ////////////////////////////////////////////////////////////////////////////

  /**
   * Build chat daemon
   */
  build() {
    // Set io
    this.__socketIO = socketio(this.eden.router.server);

    // Setup redis conn
    const conn = config.get('redis') || {};

    // Add key
    conn.key = `${config.get('domain')}.socket`;

    // Use passport auth
    this.__socketIO.use(passport.authorize({
      key    : config.get('session.key') || 'eden.session.id',
      store  : new RedisStore(config.get('redis')),
      secret : config.get('secret'),
      fail   : (data, message, critical, accept) => {
        // Accept connection
        accept(null, false);
      },
      success : (data, accept) => {
        // Accept
        accept(null, true);
      },

      cookieParser,
    }));

    // Listen for connection
    this.__socketIO.on('connection', this.onConnect);

    // Listen for global event for emit
    this.eden.on('socket.emit', this.emit, true);

    // Listen for global event for room
    this.eden.on('socket.room', this.emit, true);

    // Listen for global event for user
    this.eden.on('socket.user', this.user, true);

    // Listen for global event for key
    this.eden.on('socket.session', this.session, true);
  }


  // ////////////////////////////////////////////////////////////////////////////
  //
  // CONNECT METHODS
  //
  // ////////////////////////////////////////////////////////////////////////////

  /**
   * Set socket object
   *
   * @param {socket} socket
   */
  async onConnect(socket) {
    // on socket disconnect
    socket.on('disconnect', () => this.onDisconnect(socket));

    // check user
    const user = (!(socket.request.user || {}).logged_in) ? false : socket.request.user;

    // set ids
    const IDs = {
      userID    : user ? user.get('_id').toString() : null,
      socketID  : uuid(),
      sessionID : socket.request.cookie[config.get('session.key') || 'eden.session.id'],
    };

    // log connected
    this.logger.log('debug', `client ${IDs.socketID} - ${user ? await user.name() : 'anonymous'} connected`, {
      class : 'socket',
    });

    // set socket to map
    this.__connections.sockets.set(IDs.socketID, socket);

    // loop for sockets
    ['user', 'session'].forEach((key) => {
      // check ids
      if (!IDs[`${key}ID`]) return;

      // check has
      if (!this.__connections[`${key}s`].has(IDs[`${key}ID`])) this.__connections[`${key}s`].set(IDs[`${key}ID`], new Set());

      // push
      this.__connections[`${key}s`].get(IDs[`${key}ID`]).add(IDs.socketID);
    });

    // Send connection information
    this.eden.emit('socket.connect', {
      ...IDs,

      id  : IDs.socketID,
      key : IDs.sessionID,
    }, true);

    // On call
    socket.on('eden.call', (data) => {
      // Call data
      this.call(data, socket, user);
    });

    // On call
    socket.on('eden.route', (route) => {
      // Call data
      this.route(route, socket, user);
    });

    // add connection
    this.countConnections();
  }

  /**
   * on disconnect
   *
   * @param  {Socket}  socket
   *
   * @return {Promise}
   */
  async onDisconnect(socket) {
    // check user
    const user = (!(socket.request.user || {}).logged_in) ? false : socket.request.user;

    // set ids
    const IDs = {
      userID    : user ? user.get('_id').toString() : null,
      socketID  : uuid(),
      sessionID : socket.request.cookie[config.get('session.key') || 'eden.session.id'],
    };

    // Log disconnected
    this.logger.log('debug', `client ${IDs.socketID} - ${user ? await user.name() : 'anonymous'} disconnected`, {
      class : 'socket',
    });

    // selete socket
    this.__connections.sockets.delete(IDs.socketID);

    // loop for sockets
    ['user', 'session'].forEach((key) => {
      // check ids
      if (!IDs[`${key}ID`]) return;

      // remove
      this.__connections[`${key}s`].get(IDs[`${key}ID`]).delete(IDs.socketID);

      // delete if empty
      if (!this.__connections[`${key}s`].get(IDs[`${key}ID`]).size) this.__connections[`${key}s`].delete(IDs[`${key}ID`]);
    });

    // Send connection information
    this.eden.emit('socket.disconnect', {
      ...IDs,

      id  : IDs.socketID,
      key : IDs.sessionID,
    }, true);

    // add connection
    this.countConnections();
  }

  /**
   * Publishes socket connection count
   *
   * @param {Integer} add
   *
   * @private
   */
  async countConnections() {
    // get connections
    const connections = await this.eden.get('socket.connections') || {};

    // add connections
    connections[`${this.eden.express ? 'express' : 'compute'}.${this.eden.id}`] = this.__connections.sockets.size;

    // Publish to eden
    await this.eden.set('socket.connections', connections);

    // emit
    this.eden.emit('socket.connections', Object.values(connections).reduce((accum, amount) => {
      // return accum
      return accum + amount;
    }, 0), true);
  }


  // ////////////////////////////////////////////////////////////////////////////
  //
  // CRUD METHODS
  //
  // ////////////////////////////////////////////////////////////////////////////

  /**
   * Emit to socket funciton
   *
   * @param {Object} data
   */
  emit(data) {
    // Check if room
    if (data.room) {
      // Emit to room
      this.__socketIO.to(data.room).emit(data.type, ...data.args);
    } else {
      // Emit to everyone
      this.__socketIO.emit(data.type, ...data.args);
    }
  }

  /**
   * Creates route listener
   *
   * @param  {Object} data
   * @param  {socket} socket
   * @param  {User}   user
   */
  async call(data, socket, user) {
    // Reload user
    if (user) await user.refresh();

    // Loop endpoints
    const matched = calls.filter((call) => {
      // Remove call
      return data.name === call.path;
    });

    // Loop matched
    matched.forEach(async (call) => {
      // check ACL
      if (call.acl && !await aclHelper.validate(user, call.acl)) return;

      // get controller
      const controller = await this.eden.controller(call.file);

      // Set opts
      const opts = {
        user,
        socket,

        args      : data.args,
        call      : data.name,
        sessionID : socket.request.cookie[config.get('session.key') || 'eden.session.id'],
      };

      // Hook opts
      await this.eden.hook('socket.call.opts', opts);

      // Run endpoint
      const response = await controller[call.fn].apply(controller, [...data.args, opts]);

      // Return response
      socket.emit(data.id, response);
    });
  }

  /**
   * Creates route listener
   *
   * @param  {Object} data
   * @param  {socket} socket
   * @param  {User}   user
   */
  async route(data, socket, user) {
    // Reload user
    if (user) await user.refresh();

    // create headers
    const headers = Object.assign({}, {
      host   : socket.request.headers.host,
      origin : socket.request.headers.origin,
      cookie : socket.request.headers.cookie,

      'user-agent'      : socket.request.headers['user-agent'],
      'accept-encoding' : socket.request.headers['accept-encoding'],
      'accept-language' : socket.request.headers['accept-language'],
      'x-forwarded-for' : socket.request.headers['x-forwarded-for'],
    }, {
      Accept : 'application/json',
    });

    // get headers
    const res = await fetch(`http://${config.get('host')}:${this.eden.port}${data.route}`, {
      headers,

      redirect : 'follow',
    });

    // await text
    socket.emit(data.id, await res.json());
  }

  /**
   * Emit to user
   *
   * @param {Object} data
   */
  user(data) {
    // Check data.to
    if (!data.to || !this.__connections.users.has(data.to)) return;

    // send to all
    this.__connections.users.get(data.to).forEach((socketID) => {
      // get socket
      const socket = this.__connections.sockets.get(socketID);

      // check socket
      if (!socket) return;

      // Emit to socket
      socket.emit(data.type, ...data.args);

      // Emit to eden
      this.eden.emit('socket.user.sent', ...data.args);
    });
  }

  /**
   * Emit to user
   *
   * @param {Object} data
   */
  session(data) {
    // Check data.to
    if (!data.session || !this.__connections.sessions.has(data.session)) return;

    // send to all
    this.__connections.sessions.get(data.session).forEach((socketID) => {
      // get socket
      const socket = this.__connections.sockets.get(socketID);

      // check socket
      if (!socket) return;

      // Emit to socket
      socket.emit(data.type, ...data.args);

      // Emit to eden
      this.eden.emit('socket.session.sent', ...data.args);
    });
  }
}

/**
 * Construct socket daemon
 *
 * @type {socket}
 */
exports = module.exports = SocketDaemon;
