
// Require dependencies
import uuid         from 'uuid';
import config       from 'config';
import Daemon       from 'daemon';
import session      from 'express-session';
import socketio     from 'socket.io';
import SessionStore from '@edenjs/session-store';
import cookieParser from 'cookie-parser';

// require models
const User = model('user');

// Require helpers
const aclHelper = helper('user/acl');

/**
 * Build socket daemon
 *
 * @cluster front
 * @cluster socket
 * @priority 1000
 */
export default class SocketDaemon extends Daemon {
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
    this.id = this.id.bind(this);
    this.room = this.room.bind(this);
    this.emit = this.emit.bind(this);
    this.user = this.user.bind(this);
    this.onCall = this.onCall.bind(this);
    this.onRoute = this.onRoute.bind(this);
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
    // initializing
    this.logger.log('info', 'initializing socket.io', {
      class : this.constructor.name
    });

    // Set io
    this.__socketIO = socketio(this.eden.router.app.server);

    // Listen for connection
    this.__socketIO.on('connection', this.onConnect);

    // initialize store
    SessionStore.initialize(session);

    // socket use
    this.__sessionStore = new SessionStore({
      eden : this.eden,
    });
    this.__socketIO.use(async (socket, next) => {
      // parser
      const parser = cookieParser(config.get('secret'), {
        secret : config.get('secret'),
      });

      // await cookies parsed
      await new Promise(resolve => parser(socket.request, null, resolve));

      // set session id
      socket.request.sessionID = socket.request.cookies[config.get('session.key') || 'eden.session.id'] || socket.request.signedCookies[config.get('session.key') || 'eden.session.id'];

      // session store
      const userSession = await new Promise((resolve) => {
        // get then resolve
        this.__sessionStore.get(socket.request.sessionID, (err, data) => {
          // resolve data
          return resolve(data);
        })
      });

      // check passport
      if (userSession && userSession.passport && userSession.passport.user) {
        // set current user
        socket.request.user = await User.findById(userSession.passport.user);
        socket.request.session = userSession;
      }

      // run next
      next();
    });

    // user
    this.eden.on('socket.id', this.id, true);

    // leave/join
    this.eden.on('socket.join', (...args) => this.room('join', ...args), true);

    // leave/join
    this.eden.on('socket.leave', (...args) => this.room('leave', ...args), true);

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
    const { user } = socket.request;

    // set ids
    const IDs = {
      userID    : user ? user.get('_id').toString() : null,
      socketID  : uuid(),
      sessionID : socket.request.sessionID,
    };
    socket.IDs  = IDs;
    socket.user = user;

    // hook connect
    await this.eden.hook('socket.connect', { socket });

    // log connected
    this.logger.log('debug', `client ${IDs.socketID} - ${user ? await user.name() : 'anonymous'} connected`, {
      class : this.constructor.name,
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

    // join rooms
    if (user) socket.join(`user.${user.get('_id')}`);
    socket.join(`session.${IDs.sessionID}`);

    // On call
    socket.on('eden.call', (data) => {
      // Call data
      this.onCall(data, socket, user);
    });

    // On call
    socket.on('eden.route', (route) => {
      // Call data
      this.onRoute(route, socket, user);
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
    const { user } = socket.request;

    // hook connect
    await this.eden.hook('socket.disconnect', { socket });

    // set ids
    const { IDs } = socket;

    // Log disconnected
    this.logger.log('debug', `client ${IDs.socketID} - ${user ? await user.name() : 'anonymous'} disconnected`, {
      class : this.constructor.name,
    });

    // selete socket
    this.__connections.sockets.delete(IDs.socketID);

    // loop for sockets
    ['user', 'session'].forEach((key) => {
      // check ids
      if (!IDs[`${key}ID`]) return;

      // check size
      if (!this.__connections[`${key}s`] || !this.__connections[`${key}s`].get(IDs[`${key}ID`])) return;

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
   * emit to id
   *
   * @param param0 
   */
  id({ id, type, args }) {
    // check connections
    if (!this.__connections.sockets.has(id)) return;

    // emit
    this.__connections.sockets.get(id).emit(type, ...args);
  }

  /**
   * emit to id
   *
   * @param param0 
   */
  room(type, { id, room }) {
    // check connections
    if (!this.__connections.sockets.has(id)) return;

    // emit
    this.__connections.sockets.get(id)[type](room);
  }

  /**
   * Emit to socket funciton
   *
   * @param {Object} data
   */
  emit({ room, type, args }) {
    // Check if room
    if (room) {
      // Emit to room
      this.__socketIO.to(room).emit(type, ...args);
    } else {
      // Emit to everyone
      this.__socketIO.emit(type, ...args);
    }
  }

  /**
   * Creates route listener
   *
   * @param  {Object} data
   * @param  {socket} socket
   * @param  {User}   user
   */
  async onCall(data, socket, user) {
    // Reload user
    if (user) await user.refresh();

    // load calls
    let call = null;
    const ctrl = Object.values(this.eden.get('controllers')).find((ctrl) => {
      // return found
      const subCall = ctrl.calls.find((c) => c.path === data.name);

      // set call
      if (subCall) call = subCall;

      // return sub call
      return subCall;
    });

    // run function
    if (ctrl) {
      // check ACL
      if (call.acl && !await aclHelper.validate(user, call.acl)) return;

      // get controller
      const controller = this.eden.get(`controller.${ctrl.data.file}`);

      // Set opts
      const opts = {
        user,
        socket,

        args      : data.args,
        call      : data.name,
        sessionID : socket.IDs.sessionID,
      };

      // Hook opts
      await this.eden.hook('socket.call.opts', opts);

      // Run endpoint
      const response = await controller[call.fn](opts, ...data.args);

      // Return response
      socket.emit(data.id, response);
    }
  }

  /**
   * Creates route listener
   *
   * @param  {Object} data
   * @param  {socket} socket
   * @param  {User}   user
   */
  async onRoute(data, socket, user) {
    // Reload user
    if (user) await user.refresh();

    // create headers
    const headers = {
      host   : socket.request.headers.host,
      origin : socket.request.headers.origin,
      cookie : socket.request.headers.cookie,
      Accept : 'application/json',

      'user-agent'      : socket.request.headers['user-agent'],
      'accept-encoding' : socket.request.headers['accept-encoding'],
      'accept-language' : socket.request.headers['accept-language'],
      'x-forwarded-for' : socket.request.headers['x-forwarded-for'],
    };

    // create handlers array
    const handlers = this.eden.router.app.find(data.method, data.path).handlers || [];

    // create faux request and response
    let req = { ...socket.request };
    let res = { ...socket.request.res, send : (data, code = 200) => {
      // await text
      socket.emit(data.id, code, JSON.stringify(data));
    }, end : (data, code = 200) => {
      // await text
      socket.emit(data.id, code, JSON.stringify(data));
    }, setHeader : () => {}, getHeader : (key) => headers[key] };

    // create next
    const wrapAndNext = (i) => {
      // add to req
      req = Object.assign(req, {
        user,
        socket,
        headers,
        body      : data.body,
        query     : data.query,
        pathname  : data.path,
        sessionID : socket.IDs.sessionID,
      });

      if (!handlers[i]) console.log(handlers[i - 1].toString());

      // wrap and next
      handlers[i](req, res, () => wrapAndNext(i + 1));
    };

    // wrap and next
    wrapAndNext(0);
  }

  /**
   * Emit to user
   *
   * @param {Object} data
   */
  async user(data) {
    // Check data.to
    const done = await this.emit(Object.assign({
      room : `user.${data.to}`,
    }, data));

    // Emit to eden
    this.eden.emit('socket.user.sent', ...data.args);

    // return done
    return done;
  }

  /**
   * Emit to user
   *
   * @param {Object} data
   */
  async session(data) {
    // Check data.to
    const done = await this.emit(Object.assign({
      room : `session.${data.session}`,
    }, data));

    // Emit to eden
    this.eden.emit('socket.session.sent', ...data.args);

    // return done
    return done;
  }
}