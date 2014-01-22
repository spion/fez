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
    xtend = require("xtend/mutable"),
    clone = require("clone");

function fez(module) {
  if(require.main === module) {
    var options = getOptions(),
        ruleset = getRuleset(options);
    process.chdir(path.dirname(module.filename));
    stage(module.exports[ruleset], false, options);
  }
}

function getOptions() {
  return nopt({
    "verbose": Boolean,
    "quiet": Boolean,
    "clean": Boolean,
    "dot": Boolean
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
    if(arguments.length === 2) {
      operation = output;
      output = undefined;
    }

    rules.push({ inputs: toArray(inputs), output: output, op: operation });
  }

  defineRule.each = function(input, output, operation) {
    if(arguments.length === 2) {
      operation = output;
      output = undefined;
    }

    rules.push({ input: input, output: output, op: operation, each: true });
  };

  defineRule.use = function(ruleset) {
    toArray(ruleset).forEach(function(r) {
      requires.push(r);
    });
  };

  return defineRule;
}

function stage(ruleset, isChild, options) {
  var rules = [], 
      requires = [],
      defineRule = createRuleFns(rules, requires),
      done = null;

  defineRule.imp = function() {
    if(rules.length > 0) throw new Error("Cannot define rules in imperative mode");
    var resolver = Promise.defer();
    done = resolver.promise;
    return resolver.callback;
  };

  var result = ruleset(defineRule);
  if(done && isPromise(result)) 
    done = result;

  return resolveRequires(rules, requires, done, isChild, options);
}

function resolveRequires(rules, requires, done, isChild, options) {
  if(options.dot)
    return work(rules, options, isChild, anyWorkDone);

  var anyWorkDone = false;
  return (function nextRequire() {
    if(requires.length) {
      return stage(requires.shift(), true, options).then(function(workDone) {
        anyWorkDone = anyWorkDone || workDone;
        return nextRequire();
      });
    } else {
      if(done) return done;
      else return work(rules, options, isChild, anyWorkDone);
    }
  })();
}

function work(rules, options, isChild, prevWorkDone) {
  return Promise.all(rules.map(resolveRuleInputs)).then(function(rules) {
    var nodes = generateBuildGraph(getAllMatchingInputs(rules), rules);

    if(options.verbose)
      console.log(nodes);

    if(options.dot) {
      //console.log(nodes);
      process.stdout.write("digraph{");
      var id = 0;
      nodes.forEach(function(node) {
        node._id = id++;
        if(node.isFile()) {
          process.stdout.write(node._id + " [shape=box,label=\"" + node.file + "\"];");
        } else {
          var name = null;

          if(node.fn.value) {
            name = node.fn.value;
          } else {
            var regex = /^function ([A-Za-z$_][A-Za-z$_0-9]*)\(.*\)/,
                result = node.fn.toString().match(regex);
            if(result)
              name = result[1];
            else name = "?";
          } 

          process.stdout.write(node._id + " [label=\"" + name + "\"];");
        }
      });

      nodes.forEach(function(node) {
        if(node.output)
          process.stdout.write(node._id + "->" + node.output._id + ";");
        else if(node.outputs)
          node.outputs.forEach(function(output) {
            process.stdout.write(node._id + "->" + output._id + ";");
          });
      });
      process.stdout.write("}");
      return Promise.resolve(true);
    } else if(options.clean) {
      var cleaned = clean(nodes, options);
      if(!cleaned && !isChild && !options.quiet && !prevWorkDone)
        console.log("Nothing to clean.");
      
      return Promise.resolve(cleaned || prevWorkDone);
    } else {
      return build(nodes, isChild, prevWorkDone, options);
    }
  });
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
  var working = [];

  nodes.forEach(function(node) {
    if(node.isFile() && node.inputs.length === 0) working.push(node);
  });

  return digest(nodes, working, options).then(done.bind(this, options, isChild, prevWorkDone));
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
        if(node.output) newWorking.push(node.output);
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
        anyRejected = anyWorkDone = true;
        if(options.verbose) console.log("Rejected:", i.error());
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
    if(!isChild && Math.random() < 0.0001 && !options.quiet) console.log("We’re all stories, in the end.");
    return true;
  }
}

function performOperation(options, op) {
  if(options.verbose) {
    if(op.output)
      console.log(op.inputs.map(function(i) { return i.file; }).join(" "), "->", op.output.file);
    else
      console.log(op.inputs.map(function(i) { return i.file; }).join(" "), "-/");
  }

  var inputs = op.inputs.map(function(i) { return i.file; }),
      output = op.output ? op.output.file : null,
      out;

  if(output) {
    if(needsUpdate(inputs, [output])) {
      out = op.fn(buildInputs(inputs), [output]);
      return processOutput(out, output, inputs, options);
    } else {
      return false;
    }
  } else { //It's a task
    out = op.fn(buildInputs(inputs));
    if(isPromise(out)) return out.then(function() { return true; });
    else return true;
  }
}

function processOutput(out, output, inputs, options) {
  if(isPromise(out)) {
    return out.then(function(buffer) {
      if(buffer instanceof Buffer) {
        if(!options.quiet && output) {
          process.stdout.write("Creating ");
          cursor.green();
          process.stdout.write(output + "\n"); 
          cursor.reset();
        }

        return writep(output, buffer);
      } else if(!buffer) {
        return writep(output, new Buffer(0));
      } else if(buffer !== true) {
        throw new Error("Invalid operation output:", out);
      }

      return true;
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
  } else if(!out) {
    return writep(output, new Buffer(0));
  } else if(out !== true) {
    throw new Error("Invalid operation output:", out);
  }

  return true;
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

function flatten(arrays) {
  if(!Array.isArray(arrays)) return [arrays];

  return arrays.reduce(function(prev, array) {
    if(Array.isArray(array)) return prev.concat(flatten(array));
    else return prev.concat(flatten(array));
  }, []);
}

function getAllMatchingInputs(rules) {
  return flatten(rules.map(getMatchingInputs));
}

function getMatchingInputs(rule) {
  if(rule.each) return glob.sync(rule.input);
  return flatten(rule.inputs.map(function(globstring) {
    return glob.sync(globstring);
  }));
}

function toPromise(p) {
  if(isPromise(p)) return p;
  return Promise.resolve(p);
}

function resolveRuleInputs(rule) {
  var newRule = {};
  for(var prop in rule) {
    newRule[prop] = rule[prop];
  }

  return Promise.all(toArray(newRule.inputs)).then(function(inputs) {
    newRule.inputs = flatten(inputs);
    return newRule;
  });
}

function resolveRuleInput(input) {
  return input;
}

module.exports = fez;

