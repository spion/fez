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

Generataing the build graph like this does a few things. First, it makes sure everything that *needs* to be built *is* built. Less intelligent build systems may skip over necessary files, or offer less flexibility in rule definitions to avoid potential problems. Second, the build graph speeds things up. Rather than making multiple passes to make sure every file is handled, fez works its way up (with a topolical sort) from the source nodes of the graph (files which already exist on the file system) to the sink nodes (files which have no further outputs). Third, it gives us an opportunity to introduce concurrency (see the roadmap below) and process appropriate transformations in separate processes.