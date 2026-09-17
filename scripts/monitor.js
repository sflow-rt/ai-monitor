// Overall settings
var defaultSettings = {
    smoothing_seconds: 2,
    utilization_threshold: 80,
    utilization_timeout: 10,
    elephant_threshold: 0.2,
    subflows_per_elephant: 8,
    trace_flows: false,
    top_k: 20,
    port_Gbps: 400
};
var settings = Object.assign(defaultSettings, storeGet('settings') || {});

var stats = {'incast_congestion': 0};

// IP pair used to count aggregated flows by GPU pair
var countFlow = ['ipsource', 'ipdestination'];

// Add RoCEv2 flow keys used in ECMP hash (for path tracing)
var traceKeys = ['udpsourceport', 'udpdestinationport', 'ibbtdestinationqp'];
var traceFlow = countFlow.concat(traceKeys);

function initialize() {
    // Ingresss sampling, need to synthesize egress byte counts
    // pool bytes by output port at agent level
    setFlow('ai_monitor_egress_bytes', {
        keys: 'outputifindex',
        value: 'bytes',
        aggMode: 'AGENT',
        t: settings.smoothing_seconds, n: 100
    });

    // Set flows by egress port
    // port pair flows are pooled, large n to ensures we have flows for each busy port
    setFlow('ai_monitor_count_egress', {
        keys: 'outputifindex,' + countFlow,
        value: 'bytes',
        aggMode: 'AGENT',
        t: settings.smoothing_seconds,
        n: 100
    });

    // full ECMP has flows by ingress port
    setFlow('ai_monitor_trace_ingress', {
        keys: traceFlow,
        value: 'bytes',
        values: 'last:ipttl',
        t: settings.smoothing_seconds,
        n: settings.top_k
    });

    // Set bytes/second threshold on egress port utilization for link speed
    setThreshold('ai_monitor_egress_utilization', {
        metric: 'ai_monitor_egress_bytes',
        value: settings.port_Gbps * 1e9 * settings.utilization_threshold * 0.01 / 8,
        byFlow: true,
        timeout: settings.utilization_timeout
    });
}

initialize();

function getPath(flow) {
    var locs = flowLocations('TOPOLOGY', 'ai_monitor_trace_ingress', flow);
    // reverse sort by TTL
    locs.sort((a, b) => b.values[0] - a.values[0]);
    return locs;
}

function reportIncastCollision(agent, ifindex, flows, value, elephant_threshold) {
    stats.incast_congestion++;
    var report = {event: 'incast_congestion', agent: agent, ifindex: ifindex, flows: {merged: flows.length}, sources: [], bps: value * 8, time: Date.now()};
    // map to agent,port names
    var res = topologyInterfaceToPort(agent, ifindex);
    if (res) {
        report.node = res.node;
        report.port = res.port;
    }
    flows.forEach((flow) => {
        var [ipsource, ipdestination] = flow.key.split(',');
        report.destination = ipdestination;
        var srcRec = {source: ipsource, bps: flow.value * 8};
        report.sources.push(srcRec);
    });
    var traceFlows = activeFlows(agent, 'ai_monitor_trace_ingress', 100, elephant_threshold / settings.subflows_per_elephant, 'max', ',' + report.destination + (','.repeat(traceKeys.length)));
    report.flows.full = traceFlows.length;
    if (settings.trace_flows) {
        report.paths = [];
        traceFlows.forEach((flow) => {
            // create map of key name to key value
            var keysObj = flow.key.split(',').reduce((acc, key, idx) => {
                acc[traceFlow[idx]] = key;
                return acc;
            }, {});
            report.paths.push({keys: keysObj, path: getPath(flow.key)});
        });
    }
    logInfo(JSON.stringify(report));
}

// handle ai_monitor_egress_utilization events
setEventHandler((evt) => {
    var {agent, flowKey, threshold, value} = evt;
    // elephant is any flow above elephant_threshold of the utilized bandwidth
    // (the bandwidth needed to cross the utilization threshold), not of the total link bandwidth
    var elephant_threshold = settings.elephant_threshold * threshold;
    // get up to 100 flows larger than elephant_threshold with flowKey (egress port) as prefix
    var elephants = activeFlows(agent, 'ai_monitor_count_egress', 100, elephant_threshold, 'max', flowKey + (','.repeat(countFlow.length)));
    // incast collisions involve more than 1 flow
    if (elephants.length > 1) {
        // strip off outputifindex prefix from keys and scale from bytes to bits per second
        var prefix = flowKey + ',';
        var prefixLen = prefix.length;
        elephants.forEach((flow) => {
            flow.key = flow.key.substring(prefixLen);
            flow.value = flow.value * 8;
        });
        reportIncastCollision(agent, flowKey, elephants, value, elephant_threshold);
    }
}, ['ai_monitor_egress_utilization']);

setHttpHandler((req) => {
    var result, path = req.path;
    if (!path || path.length === 0)
        throw "not_found";
    if ('json' !== req.format)
        throw "not_found";
    switch (path[0]) {
        case 'settings':
            switch (req.method) {
                case 'GET':
                    result = settings;
                    break;
                case 'POST':
                case 'PUT':
                    Object.assign(settings, req.body);
                    storeSet('settings', settings);
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
