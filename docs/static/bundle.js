/*
GOAL: This module should mirror the NodeJS module system according the documented behavior.
The module transport will send down code that registers module definitions by an assigned path. In addition,
the module transport will send down code that registers additional metadata to allow the module resolver to
resolve modules in the browser. Additional metadata includes the following:

- "mains": The mapping of module directory paths to a fully resolved module path
- "remaps": The remapping of one fully resolved module path to another fully resolved module path (used for browser overrides)
- "run": A list of entry point modules that should be executed when ready

Inspired by:
https://github.com/joyent/node/blob/master/lib/module.js
*/
(function() {
    var win;

    if (typeof window !== 'undefined') {
        win = window;

        // This lasso modules client has already been loaded on the page. Do nothing;
        if (win.$_mod) {
            return;
        }

        win.global = win;
    }

    /** the module runtime */
    var $_mod;

    // this object stores the module factories with the keys being module paths and
    // values being a factory function or object (e.g. "/baz$3.0.0/lib/index" --> Function)
    var definitions = {};

    // Search path that will be checked when looking for modules
    var searchPaths = [];

    // The _ready flag is used to determine if "run" modules can
    // be executed or if they should be deferred until all dependencies
    // have been loaded
    var _ready = false;

    // If $_mod.run() is called when the page is not ready then
    // we queue up the run modules to be executed later
    var runQueue = [];

    // this object stores the Module instance cache with the keys being paths of modules (e.g., "/foo$1.0.0/bar" --> Module)
    var instanceCache = {};

    // This object maps installed dependencies to specific versions
    //
    // For example:
    // {
    //   // The package "foo" with version 1.0.0 has an installed package named "bar" (foo/node_modules/bar") and
    //   // the version of "bar" is 3.0.0
    //   "/foo$1.0.0/bar": "3.0.0"
    // }
    var installed = {};

    // Maps builtin modules such as "path", "buffer" to their fully resolved paths
    var builtins = {};

    // this object maps a directory to the fully resolved module path
    //
    // For example:
    //
    var mains = {};

    // used to remap a one fully resolved module path to another fully resolved module path
    var remapped = {};

    var cacheByDirname = {};

    // When a module is mapped to a global varialble we add a reference
    // that maps the path of the module to the loaded global instance.
    // We use this mapping to ensure that global modules are only loaded
    // once if they map to the same path.
    //
    // See issue #5 - Ensure modules mapped to globals only load once
    // https://github.com/raptorjs/raptor-modules/issues/5
    var loadedGlobalsByRealPath = {};

    function moduleNotFoundError(target, from) {
        var err = new Error('Cannot find module "' + target + '"' + (from ? ' from "' + from + '"' : ''));

        err.code = 'MODULE_NOT_FOUND';
        return err;
    }

    function Module(filename) {
       /*
        A Node module has these properties:
        - filename: The path of the module
        - id: The path of the module (same as filename)
        - exports: The exports provided during load
        - loaded: Has module been fully loaded (set to false until factory function returns)

        NOT SUPPORTED:
        - parent: parent Module
        - paths: The search path used by this module (NOTE: not documented in Node.js module system so we don't need support)
        - children: The modules that were required by this module
        */
        this.id = this.filename = filename;
        this.loaded = false;
        this.exports = undefined;
    }

    Module.cache = instanceCache;

    // temporary variable for referencing the Module prototype
    var Module_prototype = Module.prototype;

    Module_prototype.load = function(factoryOrObject) {
        var filename = this.id;

        if (factoryOrObject && factoryOrObject.constructor === Function) {
            // factoryOrObject is definitely a function
            var lastSlashPos = filename.lastIndexOf('/');

            // find the value for the __dirname parameter to factory
            var dirname = filename.substring(0, lastSlashPos);

            // local cache for requires initiated from this module/dirname
            var localCache = cacheByDirname[dirname] || (cacheByDirname[dirname] = {});

            // this is the require used by the module
            var instanceRequire = function(target) {
                // Only store the `module` in the local cache since `module.exports` may not be accurate
                // if there was a circular dependency
                var module = localCache[target] || (localCache[target] = requireModule(target, dirname));
                return module.exports;
            };

            // The require method should have a resolve method that will return the resolved
            // path but not actually instantiate the module.
            // This resolve function will make sure a definition exists for the corresponding
            // path of the target but it will not instantiate a new instance of the target.
            instanceRequire.resolve = function(target) {
                if (!target) {
                    throw moduleNotFoundError('');
                }

                var resolved = resolve(target, dirname);

                if (!resolved) {
                    throw moduleNotFoundError(target, dirname);
                }

                // NOTE: resolved[0] is the path and resolved[1] is the module factory
                return resolved[0];
            };

            // NodeJS provides access to the cache as a property of the "require" function
            instanceRequire.cache = instanceCache;

            // Expose the module system runtime via the `runtime` property
            // TODO: We should deprecate this in favor of `Module.prototype.__runtime`
            // @deprecated
            instanceRequire.runtime = $_mod;

            // $_mod.def("/foo$1.0.0/lib/index", function(require, exports, module, __filename, __dirname) {
            this.exports = {};

            // call the factory function
            factoryOrObject.call(this, instanceRequire, this.exports, this, filename, dirname);
        } else {
            // factoryOrObject is not a function so have exports reference factoryOrObject
            this.exports = factoryOrObject;
        }

        this.loaded = true;
    };

    /**
     * Defines a packages whose metadata is used by raptor-loader to load the package.
     */
    function define(path, factoryOrObject, options) {
        /*
        $_mod.def('/baz$3.0.0/lib/index', function(require, exports, module, __filename, __dirname) {
            // module source code goes here
        });
        */

        var globals = options && options.globals;

        definitions[path] = factoryOrObject;

        if (globals) {
            var target = win || global;
            for (var i=0;i<globals.length; i++) {
                var globalVarName = globals[i];
                var globalModule = loadedGlobalsByRealPath[path] = requireModule(path);
                target[globalVarName] = globalModule.exports;
            }
        }
    }

    function registerMain(path, relativePath) {
        mains[path] = relativePath;
    }

    function remap(fromPath, toPath) {
        remapped[fromPath] = toPath;
    }

    function builtin(name, target) {
        builtins[name] = target;
    }

    function registerInstalledDependency(parentPath, packageName, packageVersion) {
        // Example:
        // dependencies['/my-package$1.0.0/$/my-installed-package'] = '2.0.0'
        installed[parentPath + '/' + packageName] =  packageVersion;
    }

    /**
     * This function will take an array of path parts and normalize them by handling handle ".." and "."
     * and then joining the resultant string.
     *
     * @param {Array} parts an array of parts that presumedly was split on the "/" character.
     */
    function normalizePathParts(parts) {

        // IMPORTANT: It is assumed that parts[0] === "" because this method is used to
        // join an absolute path to a relative path
        var i;
        var len = 0;

        var numParts = parts.length;

        for (i = 0; i < numParts; i++) {
            var part = parts[i];

            if (part === '.') {
                // ignore parts with just "."
                /*
                // if the "." is at end of parts (e.g. ["a", "b", "."]) then trim it off
                if (i === numParts - 1) {
                    //len--;
                }
                */
            } else if (part === '..') {
                // overwrite the previous item by decrementing length
                len--;
            } else {
                // add this part to result and increment length
                parts[len] = part;
                len++;
            }
        }

        if (len === 1) {
            // if we end up with just one part that is empty string
            // (which can happen if input is ["", "."]) then return
            // string with just the leading slash
            return '/';
        } else if (len > 2) {
            // parts i s
            // ["", "a", ""]
            // ["", "a", "b", ""]
            if (parts[len - 1].length === 0) {
                // last part is an empty string which would result in trailing slash
                len--;
            }
        }

        // truncate parts to remove unused
        parts.length = len;
        return parts.join('/');
    }

    function join(from, target) {
        var targetParts = target.split('/');
        var fromParts = from == '/' ? [''] : from.split('/');
        return normalizePathParts(fromParts.concat(targetParts));
    }

    function withoutExtension(path) {
        var lastDotPos = path.lastIndexOf('.');
        var lastSlashPos;

        /* jshint laxbreak:true */
        return ((lastDotPos === -1) || ((lastSlashPos = path.lastIndexOf('/')) !== -1) && (lastSlashPos > lastDotPos))
            ? null // use null to indicate that returned path is same as given path
            : path.substring(0, lastDotPos);
    }

    function splitPackageIdAndSubpath(path) {
        path = path.substring(1); /* Skip past the first slash */
        // Examples:
        //     '/my-package$1.0.0/foo/bar' --> ['my-package$1.0.0', '/foo/bar']
        //     '/my-package$1.0.0' --> ['my-package$1.0.0', '']
        //     '/my-package$1.0.0/' --> ['my-package$1.0.0', '/']
        //     '/@my-scoped-package/foo/$1.0.0/' --> ['@my-scoped-package/foo$1.0.0', '/']
        var slashPos = path.indexOf('/');

        if (path.charAt(1) === '@') {
            // path is something like "/@my-user-name/my-scoped-package/subpath"
            // For scoped packages, the package name is two parts. We need to skip
            // past the second slash to get the full package name
            slashPos = path.indexOf('/', slashPos+1);
        }

        var packageIdEnd = slashPos === -1 ? path.length : slashPos;

        return [
            path.substring(0, packageIdEnd), // Everything up to the slash
            path.substring(packageIdEnd) // Everything after the package ID
        ];
    }

    function resolveInstalledModule(target, from) {
        // Examples:
        // target='foo', from='/my-package$1.0.0/hello/world'

        if (target.charAt(target.length-1) === '/') {
            // This is a hack because I found require('util/') in the wild and
            // it did not work because of the trailing slash
            target = target.slice(0, -1);
        }

        // Check to see if the target module is a builtin module.
        // For example:
        // builtins['path'] = '/path-browserify$0.0.0/index'
        var builtinPath = builtins[target];
        if (builtinPath) {
            return builtinPath;
        }

        var fromParts = splitPackageIdAndSubpath(from);
        var fromPackageId = fromParts[0];


        var targetSlashPos = target.indexOf('/');
        var targetPackageName;
        var targetSubpath;

        if (targetSlashPos < 0) {
            targetPackageName = target;
            targetSubpath = '';
        } else {

            if (target.charAt(0) === '@') {
                // target is something like "@my-user-name/my-scoped-package/subpath"
                // For scoped packages, the package name is two parts. We need to skip
                // past the first slash to get the full package name
                targetSlashPos = target.indexOf('/', targetSlashPos + 1);
            }

            targetPackageName = target.substring(0, targetSlashPos);
            targetSubpath = target.substring(targetSlashPos);
        }

        var targetPackageVersion = installed[fromPackageId + '/' + targetPackageName];
        if (targetPackageVersion) {
            var resolvedPath = '/' + targetPackageName + '$' + targetPackageVersion;
            if (targetSubpath) {
                resolvedPath += targetSubpath;
            }
            return resolvedPath;
        }
    }

    function resolve(target, from) {
        var resolvedPath;

        if (target.charAt(0) === '.') {
            // turn relative path into absolute path
            resolvedPath = join(from, target);
        } else if (target.charAt(0) === '/') {
            // handle targets such as "/my/file" or "/$/foo/$/baz"
            resolvedPath = normalizePathParts(target.split('/'));
        } else {
            var len = searchPaths.length;
            for (var i = 0; i < len; i++) {
                // search path entries always end in "/";
                var candidate = searchPaths[i] + target;
                var resolved = resolve(candidate, from);
                if (resolved) {
                    return resolved;
                }
            }

            resolvedPath = resolveInstalledModule(target, from);
        }

        if (!resolvedPath) {
            return undefined;
        }

        // target is something like "/foo/baz"
        // There is no installed module in the path
        var relativePath;

        // check to see if "target" is a "directory" which has a registered main file
        if ((relativePath = mains[resolvedPath]) !== undefined) {
            if (!relativePath) {
                relativePath = 'index';
            }

            // there is a main file corresponding to the given target so add the relative path
            resolvedPath = join(resolvedPath, relativePath);
        }

        var remappedPath = remapped[resolvedPath];
        if (remappedPath) {
            resolvedPath = remappedPath;
        }

        var factoryOrObject = definitions[resolvedPath];
        if (factoryOrObject === undefined) {
            // check for definition for given path but without extension
            var resolvedPathWithoutExtension;
            if (((resolvedPathWithoutExtension = withoutExtension(resolvedPath)) === null) ||
                ((factoryOrObject = definitions[resolvedPathWithoutExtension]) === undefined)) {
                return undefined;
            }

            // we found the definition based on the path without extension so
            // update the path
            resolvedPath = resolvedPathWithoutExtension;
        }

        return [resolvedPath, factoryOrObject];
    }

    function requireModule(target, from) {
        if (!target) {
            throw moduleNotFoundError('');
        }

        var resolved = resolve(target, from);
        if (!resolved) {
            throw moduleNotFoundError(target, from);
        }

        var resolvedPath = resolved[0];

        var module = instanceCache[resolvedPath];

        if (module !== undefined) {
            // found cached entry based on the path
            return module;
        }

        // Fixes issue #5 - Ensure modules mapped to globals only load once
        // https://github.com/raptorjs/raptor-modules/issues/5
        //
        // If a module is mapped to a global variable then we want to always
        // return that global instance of the module when it is being required
        // to avoid duplicate modules being loaded. For modules that are mapped
        // to global variables we also add an entry that maps the path
        // of the module to the global instance of the loaded module.

        if (loadedGlobalsByRealPath.hasOwnProperty(resolvedPath)) {
            return loadedGlobalsByRealPath[resolvedPath];
        }

        var factoryOrObject = resolved[1];

        module = new Module(resolvedPath);

        // cache the instance before loading (allows support for circular dependency with partial loading)
        instanceCache[resolvedPath] = module;

        module.load(factoryOrObject);

        return module;
    }

    function require(target, from) {
        var module = requireModule(target, from);
        return module.exports;
    }

    /*
    $_mod.run('/$/installed-module', '/src/foo');
    */
    function run(path, options) {
        var wait = !options || (options.wait !== false);
        if (wait && !_ready) {
            return runQueue.push([path, options]);
        }

        require(path, '/');
    }

    /*
     * Mark the page as being ready and execute any of the
     * run modules that were deferred
     */
    function ready() {
        _ready = true;

        var len;
        while((len = runQueue.length)) {
            // store a reference to the queue before we reset it
            var queue = runQueue;

            // clear out the queue
            runQueue = [];

            // run all of the current jobs
            for (var i = 0; i < len; i++) {
                var args = queue[i];
                run(args[0], args[1]);
            }

            // stop running jobs in the queue if we change to not ready
            if (!_ready) {
                break;
            }
        }
    }

    function addSearchPath(prefix) {
        searchPaths.push(prefix);
    }

    var pendingCount = 0;
    var onPendingComplete = function() {
        pendingCount--;
        if (!pendingCount) {
            // Trigger any "require-run" modules in the queue to run
            ready();
        }
    };

    /*
     * $_mod is the short-hand version that that the transport layer expects
     * to be in the browser window object
     */
    Module_prototype.__runtime = $_mod = {
        /**
         * Used to register a module factory/object (*internal*)
         */
        def: define,

        /**
         * Used to register an installed dependency (e.g. "/$/foo" depends on "baz") (*internal*)
         */
        installed: registerInstalledDependency,
        run: run,
        main: registerMain,
        remap: remap,
        builtin: builtin,
        require: require,
        resolve: resolve,
        join: join,
        ready: ready,

        /**
         * Add a search path entry (internal)
         */
        searchPath: addSearchPath,

        /**
         * Sets the loader metadata for this build.
         *
         * @param asyncPackageName {String} name of asynchronous package
         * @param contentType {String} content type ("js" or "css")
         * @param bundleUrl {String} URL of bundle that belongs to package
         */
        loaderMetadata: function(data) {
            // We store loader metadata in the prototype of Module
            // so that `lasso-loader` can read it from
            // `module.__loaderMetadata`.
            Module_prototype.__loaderMetadata = data;
        },

        /**
         * Asynchronous bundle loaders should call `pending()` to instantiate
         * a new job. The object we return here has a `done` method that
         * should be called when the job completes. When the number of
         * pending jobs drops to 0, we invoke any of the require-run modules
         * that have been declared.
         */
        pending: function() {
            _ready = false;
            pendingCount++;
            return {
                done: onPendingComplete
            };
        }
    };

    if (win) {
        win.$_mod = $_mod;
    } else {
        module.exports = $_mod;
    }
})();

$_mod.def("/makeup-screenreader-trap$0.0.1/util", function(require, exports, module, __filename, __dirname) { 'use strict';

// filter function for ancestor elements

var filterAncestor = function filterAncestor(item) {
  return item.nodeType === 1 && item.tagName.toLowerCase() !== 'body' && item.tagName.toLowerCase() !== 'html';
};

// filter function for sibling elements
var filterSibling = function filterSibling(item) {
  return item.nodeType === 1 && item.tagName.toLowerCase() !== 'script';
};

// reducer to flatten arrays
var flattenArrays = function flattenArrays(a, b) {
  return a.concat(b);
};

// returns all sibling element nodes of given element
function getSiblings(el) {
  var allSiblings = getPreviousSiblings(el).concat(getNextSiblings(el));

  return allSiblings.filter(filterSibling);
}

// recursive function to get previous sibling nodes of given element
function getPreviousSiblings(el) {
  var siblings = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];

  var previousSibling = el.previousSibling;

  if (!previousSibling) {
    return siblings;
  }

  siblings.push(previousSibling);

  return getPreviousSiblings(previousSibling, siblings);
}

// recursive function to get next sibling nodes of given element
function getNextSiblings(el) {
  var siblings = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];

  var nextSibling = el.nextSibling;

  if (!nextSibling) {
    return siblings;
  }

  siblings.push(nextSibling);

  return getNextSiblings(nextSibling, siblings);
}

// get ancestor nodes of given element
function getAncestors(el) {
  return getAllAncestors(el).filter(filterAncestor);
}

// recursive function to get all ancestor nodes of given element
function getAllAncestors(el) {
  var ancestors = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];

  var nextAncestor = el.parentNode;

  if (!nextAncestor) {
    return ancestors;
  }

  ancestors.push(nextAncestor);

  return getAllAncestors(nextAncestor, ancestors);
}

// get siblings of ancestors (i.e. aunts and uncles) of given el
function getSiblingsOfAncestors(el) {
  return getAncestors(el).map(function (item) {
    return getSiblings(item);
  }).reduce(flattenArrays, []);
}

module.exports = {
  getSiblings: getSiblings,
  getAncestors: getAncestors,
  getSiblingsOfAncestors: getSiblingsOfAncestors
};

});
$_mod.def("/makeup-screenreader-trap$0.0.1/index", function(require, exports, module, __filename, __dirname) { 'use strict';

var util = require('/makeup-screenreader-trap$0.0.1/util'/*'./util.js'*/);

// the main landmark
var mainEl = void 0;

// the element that will be trapped
var trappedEl = void 0;

// collection of elements that get 'dirtied' with aria-hidden attr
var dirtyObjects = void 0;

function prepareAttribute(el, dirtyValue) {
  return {
    el: el,
    cleanValue: el.getAttribute('aria-hidden'),
    dirtyValue: dirtyValue
  };
}

function dirtyAttribute(preparedObj) {
  preparedObj.el.setAttribute('aria-hidden', preparedObj.dirtyValue);
}

function cleanAttribute(preparedObj) {
  if (preparedObj.cleanValue) {
    preparedObj.el.setAttribute('aria-hidden', preparedObj.cleanValue);
  } else {
    preparedObj.el.removeAttribute('aria-hidden');
  }
}

function trap(el) {
  // ensure current trap is deactivated
  untrap();

  // update the trapped el reference
  trappedEl = el;

  // update the main landmark reference
  mainEl = document.querySelector('main, [role="main"]');

  // we must remove the main landmark to avoid issues on voiceover iOS
  if (mainEl) {
    mainEl.setAttribute('role', 'presentation');
  }

  // cache all ancestors, siblings & siblings of ancestors for trappedEl
  var ancestors = util.getAncestors(trappedEl);
  var siblings = util.getSiblings(trappedEl);
  var siblingsOfAncestors = util.getSiblingsOfAncestors(trappedEl);

  // prepare elements
  dirtyObjects = [prepareAttribute(trappedEl, 'false')].concat(ancestors.map(function (item) {
    return prepareAttribute(item, 'false');
  })).concat(siblings.map(function (item) {
    return prepareAttribute(item, 'true');
  })).concat(siblingsOfAncestors.map(function (item) {
    return prepareAttribute(item, 'true');
  }));

  // update DOM
  dirtyObjects.forEach(function (item) {
    return dirtyAttribute(item);
  });

  // let observers know the screenreader is now trapped
  var event = document.createEvent('Event');
  event.initEvent('screenreaderTrap', false, true);
  trappedEl.dispatchEvent(event);
}

function untrap() {
  if (trappedEl) {
    // restore 'dirtied' elements to their original state
    dirtyObjects.forEach(function (item) {
      return cleanAttribute(item);
    });

    dirtyObjects = [];

    // 're-enable' the main landmark
    if (mainEl) {
      mainEl.setAttribute('role', 'main');
    }

    // let observers know the screenreader is now untrapped
    var event = document.createEvent('Event');
    event.initEvent('screenreaderUntrap', false, true);
    trappedEl.dispatchEvent(event);

    trappedEl = null;
  }
}

module.exports = {
  trap: trap,
  untrap: untrap
};

});
$_mod.def("/makeup-screenreader-trap$0.0.1/docs/index", function(require, exports, module, __filename, __dirname) { var screenreaderTrap = require('/makeup-screenreader-trap$0.0.1/index'/*'../index.js'*/);

document.querySelectorAll('.trap').forEach(function (item) {
  item.addEventListener('click', function () {
    if (this.getAttribute('aria-pressed') === 'true') {
      screenreaderTrap.untrap(this);
    } else {
      screenreaderTrap.trap(this);
    }
  });

  item.addEventListener('screenreaderTrap', function (e) {
    console.log(e);
    this.innerText = 'Untrap';
    this.setAttribute('aria-pressed', 'true');
  });

  item.addEventListener('screenreaderUntrap', function (e) {
    console.log(e);
    this.innerText = 'Trap';
    this.setAttribute('aria-pressed', 'false');
  });
});

});
$_mod.run("/makeup-screenreader-trap$0.0.1/docs/index");