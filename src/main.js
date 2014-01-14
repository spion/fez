var nopt = require("nopt"),
    ansi = require("ansi"),
    cursor = ansi(process.stdout),
    through = require("through"),
    glob = require("glob"),
    path = require("path"),
    minimatch = require("minimatch"),
    Promise = require("bluebird"),
    isPromise = require("is-promise"),
    fs = require("fs"),
    mkdirp = require("mkdirp"),
    assert = require("assert"),
    Writable = require("stream").Writable,
    exec = require("child_process").exec,
    Input = require("./input"),
    generateBuildGraph = require("./graph"),
    fezUtil = require("./util"),
    xtend = require("xtend/mutable");

/*****************
 *     --o--     *
 *    |   ) |    *
 *    |    )|    *
 *    +----)+    *
 *      FEZ      *
 *****************/

function fez(module) {
  var options = getOptions(),
      ruleset = getRuleset(options);
  stage(module.exports[ruleset], false, options);
}

fez.async = function (module) {
  var options = getOptions(),
      ruleset = getRuleset(options);
  stage(module.exports[ruleset], false, options, true);
};

function getOptions() {
  return nopt({
    "verbose": Boolean,
    "quiet": Boolean,
    "clean": Boolean
  }, {
    "v": "--verbose",
    "q": "--quiet",
    "c": "--clean"
  });
}

function getRuleset(options) {
  return options.argv.remain.length ? options.argv.remain[0] : 'default';
}

function createRuleFns(rules, requires) {
  function defineRule(inputs, output, operation) {
    if(typeof output !== "string") throw new Error("Output argument of rule() must be a string");
    rules.push({ inputs: toArray(inputs), output: output, op: operation });
  }

  defineRule.each = function(input, output, operation) {
    if(typeof output !== "function") throw new Error("Output argument of rule.each() must be a function");
    if(Array.isArray(input)) throw new Error("Input argument of rule.each() must be a string");
    rules.push({ input: input, output: output, op: operation, each: true });
  };

  defineRule.requires = function(ruleset) {
    requires = requires.concat(toArray(ruleset));
  };

  return defineRule;
}

function stage(ruleset, isChild, options, async) {
  var rules = [], 
      requires = [],
      defineRule = createRuleFns(rules, requires);

  if(async) {
    var finished = false;
    var p = ruleset(defineRule, function() {
      if(isPromise(p)) throw new Error("Can't call done() when returning a promise");
      finished = true;
      resolveRequires(rules, requires, isChild, options);
    });

    if(isPromise(p)) {
      if(finished) console.log("done() has already been called");
      return p.then(resolveRequires.bind(rules, requires, isChild, options));
    }
  } else {
    ruleset(defineRule);
    return resolveRequires(rules, requires, isChild, options);
  }
}

function resolveRequires(rules, requires, isChild, options) {
  var anyWorkDone = false;
  return (function nextRequire() {
    if(requires.length) {
      return stage(requires.shift(), true, options).then(function(workDone) {
        anyWorkDone = anyWorkDone || workDone;
        return nextRequire();
      });
    } else {
      return work(rules, options, isChild, anyWorkDone);
    }
  })();
}

function work(rules, options, isChild, prevWorkDone) {
  var nodes = generateBuildGraph(getAllMatchingInputs(rules), rules);

  if(options.clean) {
    var cleaned = clean(nodes, options);
    if(!cleaned && !isChild && !options.quiet)
      console.log("Nothing to clean.");
    
    return Promise.resolve(cleaned || prevWorkDone);
  } else {
    return build(nodes, isChild, prevWorkDone, options);
  }
};

function clean(nodes, options) {
  var files = [],
      complete = 0,
      any = false;

  nodes.forEach(function(node) {
    if(node.isFile() && node.inputs.length > 0) files.push(node.file);
  });

  files.forEach(function(file) {
    try {
      fs.unlinkSync(file);
      any = true;
      
      if(!options.quiet) {
        process.stdout.write("Removing ");
        cursor.red();
        console.log(file);
        cursor.reset();
      }
    } catch(e) {}
  });

  return any;
}

function build(nodes, isChild, prevWorkDone, options) {
  return new Promise(function(resolve, reject) {
    var working = [];

    nodes.forEach(function(node) {
      if(node.isFile() && node.inputs.length === 0) working.push(node);
    });

    return digest(nodes, working, options).then(done.bind(this, options, isChild, prevWorkDone));
  });
}

function digest(nodes, working, options) {
  if(working.length === 0) return Promise.resolve(false);

  var newWorking = [];
  var promises = [];
  working.forEach(function(node) {
    if(node.isFile()) {
      node.outputs.forEach(function(out) {
        out.inComplete++;
        if(newWorking.indexOf(out) === -1)
          newWorking.push(out);
      });
    } else {//It's an operation
      //Is it ready to go?
      if(node.inComplete === node.inputs.length) {
        //Yes, do the operation and put the output on the working list
        promises.push(performOperation(options, node));
        newWorking.push(node.output);
      } else {
        //No, put it back on the working list
        newWorking.push(node);
      }
    }
  });

  return Promise.settle(promises).then(function(results) {
    var anyRejected = false,
        anyWorkDone = false;

    results.forEach(function(i) {
      if(i.isRejected()) {
        anyRejected = true;
        process.stdout.write("Rejected: ");
        cursor.red();
        console.log(i);
        cursor.reset();
      } else {
        anyWorkDone = anyWorkDone || i.value();
      }
    });

    if(anyRejected) {
      if(!options.quiet)
        console.log("An operation has failed. Aborting.");
      return anyWorkDone;
    } else {
      return digest(nodes, newWorking, options).then(function(workDone) {
          return workDone || anyWorkDone;
      });
    }
  });
}

function done(options, isChild, prevWorkDone, anyWorkDone) {
  if(!anyWorkDone && !options.quiet) {
    if(!isChild && !prevWorkDone)
      console.log("Nothing to be done.");

    return false || prevWorkDone;
  } else {
    return true;
  }
}

function performOperation(options, op) {
  if(options.verbose) {
    console.log(op.inputs.map(function(i) { return i.file; }).join(" "), "->", op.output.file);
  }

  var inputs = op.inputs.map(function(i) { return i.file; }),
      output = op.output.file;

  if(needsUpdate(inputs, [output])) {
    if(!options.quiet) {
      process.stdout.write("Creating ");
      cursor.green();
      process.stdout.write(output + "\n"); 
      cursor.reset();
    }

    var out = op.fn(buildInputs(inputs), [output]);
    if(isPromise(out)) {
      return out.then(function(buffer) {
        if(buffer !== undefined) { //(ibw) assume it's a Buffer (for now)
          return writep(output, buffer);
        } else {
          return true;
        }
      });
    } else if(out instanceof Writable) {
      return new Promise(function(resolve, reject) {
        out.pipe(fs.createWriteStream(op.output));
        out.on("end", function() {
          resolve();
        });
      });
    } else if(typeof out === "string") {
      return writep(output, new Buffer(out));
    } else if(out instanceof Buffer) {
      return writep(output, out);
    } else if(typeof out === "function") {
      throw new Error("Output can't be a function. Did you forget to call the operation in your rule (e.g op())?");
    } else {
      throw new Error("Invalid operation output:", out);
    }
  } else {
    return false;
  }
}

function buildInputs(files) {
  var inputs = [];
  files.forEach(function(file) {
    inputs.push(new Input(file));
  });

  inputs.asBuffers = function() {
    return this.map(function(i) { return i.asBuffer(); });
  };

  return inputs;
}

xtend(fez, fezUtil);

function toArray(obj) {
  if(Array.isArray(obj)) return obj;
  return [obj];
}

function writep(file, data) {
  return new Promise(function(resolve, reject) {
    mkdirp(path.dirname(file), function(err) {
      if(err) reject(err);
      fs.writeFile(file, data, function(err) {
        if(err) reject(err);
        else resolve(true);
      });
    });
  });
}

function needsUpdate(inputs, outputs) {
  var oldestOutput = Number.MAX_VALUE;
  outputs.forEach(function(out) {
    var dir = path.dirname(out);
    if(mkdirp.sync(dir)) {
      oldestOutput = 0;
    } else {
      try {
        var stat = fs.statSync(out),
            time = stat.mtime.getTime();

        if(time < oldestOutput)
          oldestOutput = time;
      } catch (e) {
        oldestOutput = 0;
      }
    }
  });

  var newestInput = 0;
  inputs.forEach(function(input) {
    try {
      var stat = fs.statSync(input),
          time = stat.mtime.getTime();

      if(time > newestInput)
        newestInput = time;
    } catch(e) {
      newestInput = 0;
    }
  });

  return newestInput > oldestOutput;
}

//(ibw) should switch to a real set data structure for maximum performance
function union(a, b) {
  var a2 = a.filter(function() { return true; });
  b.forEach(function(e) {
    if(a.indexOf(e) == -1)
      a2.push(e);
  });

  return a2;
}

function merge(arrays) {
  return arrays.reduce(function(prev, array) {
    return prev.concat(array);
  }, []);
}

function getAllMatchingInputs(rules) {
  return merge(rules.map(getMatchingInputs));
}

function getMatchingInputs(rule) {
  if(rule.each) return glob.sync(rule.input);
  return merge(rule.inputs.map(function(globstring) {
    return glob.sync(globstring);
  }));
}

module.exports = fez;

