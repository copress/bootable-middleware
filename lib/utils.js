var debug = require('debug')('bootable-middleware:utils');
var path = require('path'),
    fs = require('fs'),
    Module = require('module');

var FILE_EXTENSION_JSON = '.json';

exports.mergeObjects = mergeObjects;
function mergeObjects(target, config, keyPrefix) {
    for (var key in config) {
        var fullKey = keyPrefix ? keyPrefix + '.' + key : key;
        var err = mergeSingleItemOrProperty(target, config, key, fullKey);
        if (err) return err;
    }
    return null; // no error
}

exports.mergeSingleItemOrProperty = mergeSingleItemOrProperty;
function mergeSingleItemOrProperty(target, config, key, fullKey) {
    var origValue = target[key];
    var newValue = config[key];

    if (!hasCompatibleType(origValue, newValue)) {
        return 'Cannot merge values of incompatible types for the option `' +
            fullKey + '`.';
    }

    if (Array.isArray(origValue)) {
        return mergeArrays(origValue, newValue, fullKey);
    }

    if (typeof origValue === 'object') {
        return mergeObjects(origValue, newValue, fullKey);
    }

    target[key] = newValue;
    return null; // no error
}

exports.mergeArrays = mergeArrays;
function mergeArrays(target, config, keyPrefix) {
    if (target.length !== config.length) {
        return 'Cannot merge array values of different length' +
            ' for the option `' + keyPrefix + '`.';
    }

    // Use for(;;) to iterate over undefined items, for(in) would skip them.
    for (var ix = 0; ix < target.length; ix++) {
        var fullKey = keyPrefix + '[' + ix + ']';
        var err = mergeSingleItemOrProperty(target, config, ix, fullKey);
        if (err) return err;
    }

    return null; // no error
}

exports.hasCompatibleType = hasCompatibleType;
function hasCompatibleType(origValue, newValue) {
    if (origValue === null || origValue === undefined)
        return true;

    if (Array.isArray(origValue))
        return Array.isArray(newValue);

    if (typeof origValue === 'object')
        return typeof newValue === 'object';

    // Note: typeof Array() is 'object' too,
    // we don't need to explicitly check array types
    return typeof newValue !== 'object';
}


/**
 * Try to read a config file with .json extension
 * @param {string} cwd Dirname of the file
 * @param {string} fileName Name of the file without extension
 * @returns {Object|undefined} Content of the file, undefined if not found.
 */
exports.tryReadJsonConfig = tryReadJsonConfig;
function tryReadJsonConfig(cwd, fileName) {
    try {
        return require(path.join(cwd, fileName + '.json'));
    } catch (e) {
        if (e.code !== 'MODULE_NOT_FOUND') {
            throw e;
        }
    }
}


exports.resolveAppScriptPath = resolveAppScriptPath;
function resolveAppScriptPath(rootDir, relativePath, resolveOptions) {
    var resolvedPath = resolveAppPath(rootDir, relativePath, resolveOptions);
    var sourceDir = path.dirname(resolvedPath);
    var files = tryReadDir(sourceDir);
    var fixedFile = fixFileExtension(resolvedPath, files, false);
    return (fixedFile === undefined ? resolvedPath : fixedFile);
}


function resolveAppPath(rootDir, relativePath, resolveOptions) {
    var resolvedPath = tryResolveAppPath(rootDir, relativePath, resolveOptions);
    if (resolvedPath === undefined) {
        var err = new Error('Cannot resolve path "' + relativePath + '"');
        err.code = 'PATH_NOT_FOUND';
        throw err;
    }
    return resolvedPath;
}

function tryResolveAppPath(rootDir, relativePath, resolveOptions) {
    var fullPath;
    var start = relativePath.substring(0, 2);

    /* In order to retain backward compatibility, we need to support
     * two ways how to treat values that are not relative nor absolute
     * path (e.g. `relativePath = 'foobar'`)
     *  - `resolveOptions.strict = true` searches in `node_modules` only
     *  - `resolveOptions.strict = false` attempts to resolve the value
     *     as a relative path first before searching `node_modules`
     */
    resolveOptions = resolveOptions || { strict: true };

    var isModuleRelative = false;
    if (relativePath[0] === '/') {
        fullPath = relativePath;
    } else if (start === './' || start === '..') {
        fullPath = path.resolve(rootDir, relativePath);
    } else if (!resolveOptions.strict) {
        isModuleRelative = true;
        fullPath = path.resolve(rootDir, relativePath);
    }

    if (fullPath) {
        // This check is needed to support paths pointing to a directory
        if (fs.existsSync(fullPath)) {
            return fullPath;
        }

        try {
            fullPath = require.resolve(fullPath);
            return fullPath;
        } catch (err) {
            if (!isModuleRelative) {
                debug ('Skipping %s - %s', fullPath, err);
                return undefined;
            }
        }
    }

    // Handle module-relative path, e.g. `loopback/common/models`

    // Module.globalPaths is a list of globally configured paths like
    //   [ env.NODE_PATH values, $HOME/.node_modules, etc. ]
    // Module._nodeModulePaths(rootDir) returns a list of paths like
    //   [ rootDir/node_modules, rootDir/../node_modules, etc. ]
    var modulePaths = Module.globalPaths
        .concat(Module._nodeModulePaths(rootDir));

    fullPath = modulePaths
        .map(function(candidateDir) {
            var absPath = path.join(candidateDir, relativePath);
            try {
                // NOTE(bajtos) We need to create a proper String object here,
                // otherwise we can't attach additional properties to it
                /*jshint -W053 */
                var filePath = new String(require.resolve(absPath));
                filePath.unresolvedPath = absPath;
                return filePath;
            } catch (err) {
                return absPath;
            }
        })
        .filter(function(candidate) {
            return fs.existsSync(candidate.toString());
        })
        [0];

    if (fullPath) {
        if (fullPath.unresolvedPath && resolveOptions.fullResolve === false)
            return fullPath.unresolvedPath;
        // Convert String object back to plain string primitive
        return fullPath.toString();
    }

    debug ('Skipping %s - module not found', fullPath);
    return undefined;
}

function tryReadDir() {
    try {
        return fs.readdirSync.apply(fs, arguments);
    } catch (e) {
        return [];
    }
}

function resolveRelativePaths(relativePaths, appRootDir) {
    var resolveOpts = { strict: false };
    relativePaths.forEach(function(relativePath, k) {
        var resolvedPath = tryResolveAppPath(appRootDir, relativePath, resolveOpts);
        if (resolvedPath !== undefined) {
            relativePaths[k] = resolvedPath;
        } else {
            debug ('skipping boot script %s - unknown file', relativePath);
        }
    });
}

function getExcludedExtensions() {
    return {
        '.json': '.json',
        '.node': 'node'
    };
}

function isPreferredExtension (filename) {
    var includeExtensions = require.extensions;

    var ext = path.extname(filename);
    return (ext in includeExtensions) && !(ext in getExcludedExtensions());
}

function fixFileExtension(filepath, files, onlyScriptsExportingFunction) {
    var results = [];
    var otherFile;

    /* Prefer coffee scripts over json */
    if (isPreferredExtension(filepath)) return filepath;

    var basename = path.basename(filepath, FILE_EXTENSION_JSON);
    var sourceDir = path.dirname(filepath);

    files.forEach(function(f) {
        otherFile = path.resolve(sourceDir, f);

        var stats = fs.statSync(otherFile);
        if (stats.isFile()) {
            var otherFileExtension = path.extname(f);

            if (!(otherFileExtension in getExcludedExtensions()) &&
                path.basename(f, otherFileExtension) == basename) {
                if (!onlyScriptsExportingFunction)
                    results.push(otherFile);
                else if (onlyScriptsExportingFunction &&
                    (typeof require.extensions[otherFileExtension]) === 'function') {
                    results.push(otherFile);
                }
            }
        }
    });
    return (results.length > 0 ? results[0] : undefined);
}