<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**  *generated with [DocToc](https://github.com/thlorenz/doctoc)*

- [snapshot](#snapshot)
  - [Goal](#goal)
  - [Tooling](#tooling)
    - [Packages](#packages)
  - [Snapshot Creation](#snapshot-creation)
    - [1. Preparation](#1-preparation)
      - [1.1. Consolidating Duplicate Module Installs](#11-consolidating-duplicate-module-installs)
      - [1.2. Generate Dependency Metadata](#12-generate-dependency-metadata)
      - [1.3. Generate the Snapshot Entry](#13-generate-the-snapshot-entry)
    - [2. Snapshot Doctor](#2-snapshot-doctor)
  - [Snapshot Loading](#snapshot-loading)
  - [Development Mode](#development-mode)
    - [Opting out](#opting-out)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

# snapshot

This package is responsible for building an electron snapshot for the application and replace
the original electron snapshot with it.

The built snapshot includes all `node_modules` in either `module.exports` fully initialized as
`Object` form or as a `function` that needs to be called to obtain `module.exports`.

For _production_ builds the application modules are included in the snapshot as well.

When the app is running modules are _imported_ from the snapshot via a `require` hook defined
inside the `../ts/` package.

## Goal

The reason we want to bake a snapshot of modules into the Cypress app is to improve startup
times. The improvement is especially drastic in _production_ mode, but noticable in
_development_ mode as well, where we saw startup times reduced by `20%`.

## Development Mode

When developing the Cypress app, a snapshot rebuild is required each time `node_modules` are
updated resulting in a change to `yarn.lock`. This step is performed as a _post install_ step
automatically (TODO not yet) and the developer doesn't need to do anything in this case.

The only case when a developer has to manually trigger a snapshot rebuild is if he edited
`node_modules` directly and wants to keep using the snapshot with the updated code.

### Opting out

If using the snapshot causes problems or the developer wants to run the app without it then he
should start the app via `yarn dev-nosnap` (TODO provide the script) instead of just `yarn
snap`. In this case the snapshot is still loaded into the app, but modules aren't resolved from
it.

## Tooling

This package includes scripts to orchestrate building the snapshot and making sure it stays up
to date in _development_ mode.

### Packages

The following package dependencies provide snapshot building/loading functionality.
They are explained in more detail in conjunction with the snapshot creation workflow as well as
the snapshot loading workflow.


- [**v8-snapshot**](https://github.com/thlorenz/v8-snapshot): responsible for creating and
  loading the snapshot as well as hooking `require` based imports to load modules from it when
  present
- [**esbuild**](https://github.com/cypress-io/esbuild) a fork of _esbuild_ which includes a
  _snapshot printer_ which is used to rewrite the code in and bundle it into _snapshotable_
  bundle
  - an installable version of this tool for macOS is provided via
    [**snapbuild-darwin-x64**](https://www.npmjs.com/package/snapbuild-darwin-x64) and used by
    _v8-snapshot_ under the hood
- [**packherd**](https://github.com/thlorenz/packherd) responsible for hooking the `require` in
  order to resolve _imports_ from the snapshot and/or _transpile_ TypeScript on the fly
  - TypeScript _transpilation_ is performed by [esbuild](https://github.com/evanw/esbuild) and
    transpiled files are cached in the filesystem via
    [dirt-simple-file-cache](https://github.com/thlorenz/dirt-simple-file-cache)

## Snapshot Creation

### 1. Preparation

The following steps prefer the efficient creation of a proper snapshot bundle.

#### 1.1. Consolidating Duplicate Module Installs

Removing duplicates speeds up snapshot creation immensly since the _doctor_ step needs to
consider less options.

- remove duplicates of _bluebird_ deps to speed up snapshot creation and avoid complications
- remove duplicates of _lodash_ deps to speed up snapshot creation

#### 1.2. Generate Dependency Metadata

In this step _v8-snapshot_ generates a JSON file that includes information about all modules
that are imported by the application. This includes file size and imports of other modules.

This metadata is used to generate the snapshot entry file, but also allows diagnosing
dependencies regarding initialization times, etc. _packherd_ includes
[scripts](https://github.com/thlorenz/packherd/tree/master/scripts) to that regard.

#### 1.3. Generate the Snapshot Entry

Starting from the provided entry point to the electron application the _v8-snapshot_ tool
follows imports in order to discover all modules that need to be included in the snapshot and
writes them into a `snapshot-entry.js` file which just consists of _imports_ of those modules.

```js
exports['../../../../node_modules/@babel/parser/lib/index.js'] = require('../../../../node_modules/@babel/parser/lib/index.js')
exports['../../../../node_modules/@babel/runtime/helpers/arrayLikeToArray.js'] = require('../../../../node_modules/@babel/runtime/helpers/arrayLikeToArray.js')
exports['../../../../node_modules/@babel/runtime/helpers/arrayWithHoles.js'] = require('../../../../node_modules/@babel/runtime/helpers/arrayWithHoles.js')
// many more
```

Generating this file not only speeds up future snapshot generations but also allows
inspecting/debugging modules that are included.

### 2. Snapshot Doctor

The _snapshot doctor_ determines which modules can be included fully initialized, which need to
be _deferred_ and which ones should not be rewritten. The result of the _doctor_ step is a
`snapshot-meta.json` meta file containing the following properties.

- **norewrite**: modules that should not be rewritten since either the code transformation
resulted in invalid code or could not be performed 
- **deferred**: modules that could be rewritten properly, but even after that step ran code
during the `module.exports` intialization that cannot run when snapshotting the bundle
- **healthy**: modules that after a rewrite can fully initialize `module.exports` without
causing issues during snapshotting 
- **deferredHashFile** file used to create _deferredHash_
- **deferredHash** hash which is used to determine if the current _snapshot bundle_ and related
metadata needs to be updated

_norewrite_ modules are included in the _snapshot bundle_ unchanged as a _function_ that is
called when the application runs in ordert to initialize `module.exports`.

_deferred_ modules are rewritten before being included as functions in the _snapshot bundle_.
Like _norewrite_ modules they need to be initialized when the application runs.

_healthy_ modules can be fully initialized during _snapshotting_ and thus the _snapshot
bundle_ is created in a way that they are.

#### First Time Doctor

When the _createSnapshot_ step is performed for the first time via the _v8-snapshot_ tool no
previous snapshot metadata nor bundle is present and thus all steps start from scratch.

After preparation completes the doctor will determine which modules should _norewrite_,
_deferred_ and which ones are _healthy_. The steps to do this are roughly the following:

1. build the initial _snapshot bundle_ and discover modules generating invalid code, mark them as
_norewrite_
2. build another _snapshot bundle_ not rewriting those modules and then try to load each module
directly to determine if it's healthy or should be deferred. This step is performed by walking
the dependency tree backwards, i.e. starting with the leafs
3. whenever deferred modules have been discovered and no modules that don't depend on them can
be evaluated build a new _snapshot bundle_ deferring the modules that were marked as such
4. repeat 2-3 until all modules have been marked
5. try to optimize the deferreds
  - push down deferreds, i.e. defer a dep instead of the entire module
  - remove explicit defers for deps which are explicitly deferred via their parent
6. TODO continue here

## Snapshot Loading

