var fez = require("../../src/main.js"),
    less = require("fez-less"),
    clean = require("fez-clean-css"),
    concat = require("fez-concat");

exports.build = function(stage) {
  /* Stage a new build graph */
  stage(function(rule) {
    /*
     * Concat every minified css file into a single distribution. This is
     * intentionally out of order to illustrate that rule declaration order
     * doesn't matter in Fez.
     */  
    rule("dist/*.min.css", "dist.min.css", concat());

    /*
     * Run cleancss on each css file in the css/ directory, producing a
     * corresponding minified file for each input in the dist/ directory. mapFile,
     * as it's used here, names the output file base on the input, where %f is
     * replaced with the filename of the input minus its extension.
     */
    rule.each("css/*.css", fez.mapFile("dist/%f.min.css"), clean());

    /*
     * Run LESS on every less source file, producing a corresponding css file in
     * the css directory. Pass some configuration options to LESS.
     */
    rule.each("*.less", fez.mapFile("css/%f.css"), less({ rootpath: "public/" }));
  });
};

exports.default = exports.build;

fez(module);
