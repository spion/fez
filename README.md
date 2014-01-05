Fez
===

![](fez.png)

Woot!

Let's say we have the following ruleset:

    *.less -> %f.css
    *.css -> %f.min.css
    *.min.css -> dist.min.css

And a few input files on our file system:

![](https://dl.dropboxusercontent.com/u/10832827/before.svg)

Fez takes the ruleset and the input files and generates a build graph:

![](https://dl.dropboxusercontent.com/u/10832827/after.svg)

Generating the build graph like this does a few things. First, it makes sure everything that *needs* to be built *is* built. Less intelligent build systems may skip over necessary files, or offer less flexibility in rule definitions to avoid potential problems. Second, the build graph speeds things up. Rather than making multiple passes to make sure every file is handled, fez works its way up (with a topological sort) from the source nodes of the graph (files which already exist on the file system) to the sink nodes (files which have no further outputs). Third, it gives us an opportunity to introduce concurrency (see the roadmap below) and process appropriate transformations in separate processes.

Using
-----

Fez build specs are simple Javascript files, usually called `fez.js` in a project's root directory. There is no command line fez tool; instead, fez build specs are self-executable. The basic outline of a `fez.js` file usually something like this:

    var fez = require("fez");

    exports.build = function(rule) {
      ...    		  
    };

    exports.default = exports.build;

    fez(module);

Let's step through this line by line.

    var fez = require("fez");

Requiring `fez` isn't strictly required, but is necessary in making `fez.js` self-executable. The only case in which you might not want it is if you have child build specs which are never run on their own. Even then, `fez` comes with quite a bit of utility functionality for crafting useful rulesets.

    exports.build = function(rule) {

Rulesets (a variation on tasks, or targets) are specified by adding fields to `module.exports`. A ruleset takes the form of a function which uses its argument, `rule`, to define a set of rules to be used in generating the build graph. We'll talk more about crafting rulesets later on. For now, just know that every ruleset is a function, and is named.

    exports.default = exports.build;

The ruleset named `default` has special meaning in fez. When `fez.js` is run without any command line options (i.e `node fez.js`), the `default` ruleset is run. We specify the `default` ruleset just like any other: by adding a field named `default` to `module.exports`.

    fez(module);

This is the tiny bit of magic that makes `fez.js` self-executable. The `fez` function takes a module (almost always the current module) as an argument. If that module is the *main* module (i.e the file which was run with `node fez.js`), fez will parse command line options and run the builds generated from the rulesets in the module. This line should be in every build spec unless you are sure you will never want to run the build spec on its own. It is safe (and recommended) to include the line even in build specs which will be used primarily as child specs. Using child specs will be discussed in more detail below.