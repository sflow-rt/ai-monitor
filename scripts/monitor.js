// Overall settings
var defaultSettings = {
  smoothing_seconds:0.5,
  utilization_threshold: 90,
  elephant_threshold: 0.2,
  top_k: 5,
  port_Gbps:400
};
var settings = Object.assign(defaultSettings, storeGet('settings') || {});

var stats = {'incast_congestion':0};

// RoCEv2 flow keys used in ECMP hash (for path tracing)
var flow = ['ipsource','ipdestination','udpsourceport','udpdestinationport','ibbtdestinationqp'];

function initialize() {
  // Ingresss sampling, need to synthesize egress byte counts
  // pool bytes by output port at agent level
  setFlow('ai_monitor_egress_bytes', {
    keys:'outputifindex',
    value:'bytes',
    aggMode:'AGENT',
    t:settings.smoothing_seconds, n:100
  });

  // Set RoCEv2 flows by egress port
  // flows are pooled, so increase n to ensure we have flows for each busy port
  setFlow('ai_monitor_rocev2_egress', {
    keys:'outputifindex,'+flow,
    value:'bytes',
    aggMode:'AGENT',
    t:settings.smoothing_seconds,
    n:100
   });

  // RoCEv2 flows by ingress port
  setFlow('ai_monitor_rocev2_ingress', {
    keys:flow,
    value:'bytes',
    values:'last:ipttl',
    t:settings.smoothing_seconds,
    n:settings.top_k
  });

  // Set bytes/second threshold on egress port utilization for link speed
  setThreshold('ai_monitor_egress_utilization', {
    metric:'ai_monitor_egress_bytes',
    value:settings.port_Gbps * 1e9 * settings.utilization_threshold * 0.01 / 8,
    byFlow:true,
    t:2
  });
}

initialize();

function getPath(flow) {
   var paths = flowLocations('TOPOLOGY','ai_monitor_rocev2_ingress',flow);
   // reverse sort by TTL
   paths.sort((a,b)=>b.values[0] - a.values[0]);
   return paths;
}

function reportIncastCollision(agent,ifindex,flows) {
  stats.incast_congestion++;
  var report = {event:'incast_congestion',agent:agent,ifindex:ifindex,time:Date.now()};
  // map to agent,port names
  var res = topologyInterfaceToPort(agent,ifindex);
  if(res) {
     report.node=res.node;
     report.port=res.port;
  }
  // lookup the path for each flow key
  var paths = [];
  flows.forEach((key) => {
    var keys = key.split(',');
    var keysObj = keys.reduce((acc,key,idx)=> {
      acc[flow[idx]] = key;
      return acc;
    }, {});
    paths.push({
      keys: keysObj,
      path: getPath(key)
    });
  });
  report.paths = paths;
  logInfo(JSON.stringify(report));
}

// handle ai_monitor_egress_utilization events
setEventHandler((evt) => {
  var {agent, flowKey, threshold, value} = evt;
  // get up to 100 flows larger than 1Mbps
  var flows = activeFlows(agent,'ai_monitor_rocev2_egress',100,1e6);
  // filter the flows by egress port
  // flowKey in the egress_bytes flow is the egress port
  var prefix = flowKey + ',';
  // elephant is any flow responsible for 20% of bandwidth needed to cross threshold
  var elephant_threshold = settings.elephant_threshold;
  var elephants = flows.filter((el) => el.key.startsWith(prefix) && el.value >= elephant_threshold);
  // incast collisions involve more than 1 flow
  if(elephants.length > 1) {
     // strip off outputifindex prefix
     var prefixLen = prefix.length;
     var elephantKeys = elephants.map((el) => el.key.substring(prefixLen));

     reportIncastCollision(agent,flowKey,elephantKeys);
  }
}, ['ai_monitor_egress_utilization']);

setHttpHandler((req) => {
  var result, path = req.path;
  if(!path || path.length == 0) throw "not_found";
  if('json' !== req.format) throw "not_found";
  switch(path[0]) {
    case 'settings':
      switch(req.method) {
        case 'GET':
          result = settings;
          break;
        case 'POST':
        case 'PUT':
          Object.assign(settings,req.body);
          storeSet('settings',settings);
          initialize();
          break;
      }
      break;
    case 'statistics':
      result = stats;
      break;
    default:
      throw 'not_found';
  }
  return result;
});
