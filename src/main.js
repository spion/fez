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
  var options = nopt({
    "verbose": Boolean,
    "quiet": Boolean,
    "clean": Boolean
  }, {
    "v": "--verbose",
    "q": "--quet",
    "c": "--clean"
  });

  var ruleset = options.argv.remain.length ? options.argv.remain[0] : 'default';
  stage(module.exports[ruleset], false, options);
}

function createRuleFns(rules, requires) {
  function defineRule(inputs, output, operation) {
    if(typeof output !== "string") throw new Error("Output argument of rule() must be a string");

    rules.push({ inputs: toArray(inputs), output: output, op: operation });
  }

  //One to one relationships where you want to pass in multiple inputs (i.e
  //from a glob, array, or generator). Repeats the operation for each input
  //with the output. I'M NOT SURE I LIKE THE SEMANTICS OF THIS FUNCTION. USE
  //AT YOUR OWN RISK. -ibw
  defineRule.each = function(input, output, operation) {
    if(typeof output !== "function") throw new Error("Output argument of rule.each() must be a function");

    //(ibw) will need to add a mechanism for array inputs once I sort out the
    //semantics. See https://gist.github.com/isaacbw/8311616 for a possible
    //use case.
    if(Array.isArray(input)) throw new Error("Input argument of rule.each() must be a string");

    rules.push({ input: input, output: output, op: operation, each: true });
  };

  //Pass complete input and output arrays to operation Useful for many-many
  //operations, which should really be limited to shell commands. Native fez
  //operations should try very hard to be one-one or many-one operations with a
  //single output.
  defineRule.many = function(inputs, outputs, operation) {
    rules.push({ inputs: toArray(inputs), outputs: toArray(outputs), op: operation, many: true });
  };
  
  //A task is a special rule which has no output. It will be run each time the
  //ruleset is run, since there are no output files with which to compare
  //timestamps.
  defineRule.task = function(inputs, operation) {
    rules.push({ inputs: toArray(inputs), op: operation, task: true });
  };

  defineRule.task.each = function(inputs, operation) {
    toArray(inputs).forEach(function(input) {
      rules.push({ inputs: [input], op: operation, task: true, each: true });
    });
  };

  defineRule.requires = function(ruleset) {
    requires = requires.concat(toArray(ruleset));
  };

  return defineRule;
}

function stage(ruleset, isChild, options) {
  var rules = [], requires = [];

  //One to one or many to one relationships. Repeats the operation for each
  //output if there are multiple, passing the complete input array each time.
  var defineRule = createRuleFns(rules, requires);
  ruleset(defineRule);

  return new Promise(function() {
    var anyWorkDone = false;
    return (function nextRequire(prevWorkDone) {
      if(requires.length) {
        return stage(requires.shift(), true, options).then(function(workDone) {
          anyWorkDone = anyWorkDone || workDone;
          return nextRequire();
        });
      } else {
        return work(rules, options, isChild, anyWorkDone);
      }
    })();
  });
}

function work(rules, options, isChild, prevWorkDone) {
  return new Promise(function(resolve, reject) {
    var outs = [],
        nextTask = 0;

    var tasks = [];
    function Task(rule) {
      this.rule = rule;
      this.inEdges = 0;
      this.inComplete = 0;
      this.inFiles = [];
      tasks.push(this);
    }

    var edges = generateBuildGraph(getAllMatchingInputs(rules), rules),
        working = [],
        createdCount = 0,
        taskCount = 0;

    //Create a build graph in object form from the edge list we have
    //currently
    var inEdges = {};
    edges.forEach(function(edge) {
      if(inEdges[edge[0]] === undefined)
        inEdges[edge[0]] = { n: 0, op: edge[1] };
      else if(inEdges.op === undefined)
        inEdges.op = edge[1];

      if(!inEdges[edge[1].output])
        inEdges[edge[1].output] = {n: 1};
      else
        inEdges[edge[1].output].n++;
    });

    for(var node in inEdges) {
      if(inEdges[node].n === 0) {
        working.push(inEdges[node].op);
        inEdges[node].op.inComplete = 1;
      }
    }

    digest(edges, working, options).then(done);

    function done() {
      if(createdCount === 0 && taskCount === 0 && !options.quiet) {
        if(!isChild && !prevWorkDone) {
          console.log("Nothing to be done.");
        }

        resolve(false || prevWorkDone);
      } else {
        if(!isChild && prevWorkDone) {
          console.log("Success.");
        }
        reject(true);
      }
    }

  });
}

function tasksForInput(edges, input) {
  var result = [];
  for(var i = 0; i < edges.length; i++) {
    var edge = edges[i];
    if(edge[0] === input) {
      result.push(edge[1]);
    }
  }

  return result;
}

function performOperation(options, op) {
  if(options.verbose) {
    console.log(op.inputs.join(" "), "->", op.output);
  }

  if(needsUpdate(op.inputs, [op.output])) {
    process.stdout.write("Creating ");
    cursor.green();
    process.stdout.write(op.output + "\n"); 
    cursor.reset();

    var out = op.fn(buildInputs(op), [op.output]);
    if(isPromise(out)) {
      return out.then(function(buffer) {
        if(buffer !== undefined) { //(ibw) assume it's a Buffer (for now)
          var ps = [];
          ps.push(writep(op.output, buffer));

          return Promise.all(ps);
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
    }
  }
}

function buildInputs(op) {
  var inputs = [];
  op.inputs.forEach(function(file) {
    inputs.push(new Input(file));
  });

  inputs.asBuffers = function() {
    return this.map(function(i) { return i.asBuffer(); });
  };

  return inputs;
}

function digest(edges, working, options) {
  if(!working.length) return true;

  var newWorking = [];
  var promises = [];
  working.forEach(function(op) {
    //Ready to go?
    if(op.inComplete === op.inEdges) {
      promises.push(performOperation(options, op));

      var outs = tasksForInput(edges, op.output);
      outs.forEach(function(out) {
        out.inComplete++;
      });

      newWorking = union(newWorking, outs);
    } else {
      //Put it back on the working list
      newWorking.push(op);
    }
  });

  return Promise.settle(promises).then(function(results) {
    var anyRejected = false;
    results.forEach(function(i) {
      if(i.isRejected()) {
        anyRejected = true;
        console.log(i);
      }
    });

    if(anyRejected) {
      if(!options.quiet) {
        console.log("An operation has failed. Aborting.");
        return [];
      }
    } else {
      return digest(edges, newWorking, options);
    }
  });
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
        else resolve();
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

