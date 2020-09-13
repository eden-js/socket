const config = {};

config.frontend = {
  riot : {
    include : {
      socket  : 'socket/public/js/bootstrap', // Include socket module
    },
  },
};

module.exports = config;
