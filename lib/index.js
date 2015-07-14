var debug = require('debug')('bootable-middleware');
var path = require('path');
var assert = require('assert');
var _ = require('lodash');
var configup = require('configup');
var expressx = require('expressx');

/**
 *
 * @param dir the relative or absolute dir where is the middleware config file. default is `config`.
 * @returns {Function}
 */
module.exports = function middleware(dir) {
    return function () {
        var app = this.app;
        var rootDir = path.resolve(this.root || process.cwd(), dir || '.');
        load(app, rootDir);
    };
};

/**
 *
 * @param {Object} app witty application or express application
 * @param {String} dir
 * @param {String} [env]
 */
function load(app, dir, env) {
    app = expressx(app); // ensure app has `middleware` function
    env = env || app.get('env');
    var config = dir;
    if (typeof dir === 'string') {
        config = loadMiddleware(dir, env);
    }
    var instructions = buildMiddlewareInstructions(dir, config);
    setupMiddleware(app, instructions);
}

function loadMiddleware(dir, env) {
    return configup.load(path.resolve(dir, 'middleware'), env, mergeMiddlewareConfig);
}

function mergeMiddlewareConfig(target, config, fileName) {
    var err;
    for (var phase in config) {
        if (phase in target) {
            err = mergePhaseConfig(target[phase], config[phase], phase);
        } else {
            err = 'The phase "' + phase + '" is not defined in the main config.';
        }
        if (err)
            throw new Error('Cannot apply ' + fileName + ': ' + err);
    }
}

function mergePhaseConfig(target, config, phase) {
    var err;
    for (var middleware in config) {
        if (middleware in target) {
            err = configup.mergeObjects(target[middleware], config[middleware]);
        } else {
            err = 'The middleware "' + middleware + '" in phase "' + phase + '"' +
                'is not defined in the main config.';
        }
        if (err) return err;
    }
}

function buildMiddlewareInstructions(rootDir, config) {
    var phasesNames = Object.keys(config);
    var middlewareList = [];
    phasesNames.forEach(function (phase) {
        var phaseConfig = config[phase];
        Object.keys(phaseConfig).forEach(function (middleware) {
            var allConfigs = phaseConfig[middleware];
            if (!Array.isArray(allConfigs))
                allConfigs = [allConfigs];

            allConfigs.forEach(function (config) {
                var resolved = resolveMiddlewarePath(rootDir, middleware);

                var middlewareConfig = _.cloneDeep(config);
                middlewareConfig.phase = phase;

                if (middlewareConfig.params) {
                    middlewareConfig.params = resolveMiddlewareParams(
                        rootDir, middlewareConfig.params);
                }

                var item = {
                    sourceFile: resolved.sourceFile,
                    config: middlewareConfig
                };
                if (resolved.fragment) {
                    item.fragment = resolved.fragment;
                }
                middlewareList.push(item);
            });
        });
    });

    var flattenedPhaseNames = phasesNames
        .map(function getBaseName(name) {
            return name.replace(/:[^:]+$/, '');
        })
        .filter(function differsFromPreviousItem(value, ix, source) {
            // Skip duplicate entries. That happens when
            // `name:before` and `name:after` are both translated to `name`
            return ix === 0 || value !== source[ix - 1];
        });

    return {
        phases: flattenedPhaseNames,
        middleware: middlewareList
    };
}


function resolveMiddlewarePath(rootDir, middleware) {
    var resolved = {};

    var segments = middleware.split('#');
    var pathName = segments[0];
    var fragment = segments[1];
    var middlewarePath = pathName;
    var opts = {strict: true};

    if (fragment) {
        resolved.fragment = fragment;
    }

    if (pathName.indexOf('./') === 0 || pathName.indexOf('../') === 0) {
        // Relative path
        pathName = path.resolve(rootDir, pathName);
    }

    var resolveOpts = _.extend(opts, {
        // Workaround for strong-agent to allow probes to detect that
        // strong-express-middleware was loaded: exclude the path to the
        // module main file from the source file path.
        // For example, return
        //   node_modules/strong-express-metrics
        // instead of
        //   node_modules/strong-express-metrics/index.js
        fullResolve: false
    });
    var sourceFile = configup.resolveAppScriptPath(rootDir, middlewarePath, resolveOpts);

    if (!fragment) {
        resolved.sourceFile = sourceFile;
        return resolved;
    }

    // Try to require the module and check if <module>.<fragment> is a valid
    // function
    var m = require(pathName);
    if (typeof m[fragment] === 'function') {
        resolved.sourceFile = sourceFile;
        return resolved;
    }

    /*
     * module/server/middleware/fragment
     * module/middleware/fragment
     */
    var candidates = [
        pathName + '/server/middleware/' + fragment,
        pathName + '/middleware/' + fragment
        // TODO: [rfeng] Should we support the following flavors?
        // pathName + '/lib/' + fragment,
        // pathName + '/' + fragment
    ];

    var err;
    for (var ix in candidates) {
        try {
            resolved.sourceFile = configup.resolveAppScriptPath(rootDir, candidates[ix], opts);
            delete resolved.fragment;
            return resolved;
        }
        catch (e) {
            // Report the error for the first candidate when no candidate matches
            if (!err) err = e;
        }
    }
    throw err;
}

// Match values starting with `$!./` or `$!../`
var MIDDLEWARE_PATH_PARAM_REGEX = /^\$!(\.\/|\.\.\/)/;

function resolveMiddlewareParams(rootDir, params) {
    return _.cloneDeep(params, function resolvePathParam(value) {
        if (typeof value === 'string' && MIDDLEWARE_PATH_PARAM_REGEX.test(value)) {
            return path.resolve(rootDir, value.slice(2));
        } else {
            return undefined; // no change
        }
    });
}

function setupMiddleware(app, instructions) {
    // Phases can be empty
    var phases = instructions.phases || [];
    assert(Array.isArray(phases), 'instructions.phases must be an array');

    var middleware = instructions.middleware;
    assert(Array.isArray(middleware), 'instructions.middleware must be an object');

    debug('Defining middleware phases %j', phases);
    app.defineMiddlewarePhases(phases);

    middleware.forEach(function (data) {
        debug('Configuring middleware %j%s', data.sourceFile,
            data.fragment ? ('#' + data.fragment) : '');
        var factory = require(data.sourceFile);
        if (data.fragment) {
            factory = factory[data.fragment].bind(factory);
        }
        assert(typeof factory === 'function',
            'Middleware factory must be a function');
        app.middlewareFromConfig(factory, data.config);
    });
}
