var path = require('path');
var loader = require('./lib/loader');

module.exports = function middleware(dir) {
    dir = dir || 'config';

    return function () {
        var app = this.app;
        var root = this.root || process.cwd();
        loader.load(app, path.resolve(root, dir));
    };
};

