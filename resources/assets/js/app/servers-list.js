const notify = require('./notify');
const ServersGraph = require('./servers-graph');

/*
 * Per-servers realtime graph manager
 */
const ServersRealtimeGraphs = function (vueServersList) {
    this.init(vueServersList);
};

ServersRealtimeGraphs.prototype = {
    /**
     * Initialize realtime graphs. Called on construct.
     *
     * @param vueServersList the servers list vue
     */
    init: function (vueServersList) {
        this._vueServersList = vueServersList;
        this._graphs = {};
        this._pingMaxId = null;
        this._pingTask = null;

        // Bind events
        $(window).resize(this._onWindowResize = _.debounce(function () {
            this.reflowContainers();
        }.bind(this), 200, {maxWait: 1000}));
    },

    /**
     * Reflow containers (when window size change, ...)
     */
    reflowContainers: function () {
        // TODO(nathan818): Config to enable/disable this "same-size" graphs option
        var graph;
        var width;
        var minWidth = null;

        for (var i in this._graphs) {
            graph = this._graphs[i];
            width = $(graph.container).parent().parent().width();
            if (minWidth === null || width < minWidth) {
                minWidth = width;
            }
        }
        for (var i in this._graphs) {
            graph = this._graphs[i];
            var container = $(graph.container).parent();
            width = container.parent().width();
            container.width(minWidth + 'px');
            graph.reflow();
        }
    },

    /**
     * Check for servers update after a vue DOM update
     */
    updateServers: function () {
        var hasNew = false;
        var serverIds = [];

        // Create new graphs
        this._vueServersList.servers.forEach(function (server) {
            serverIds.push(server.id);
            if (!this._graphs[server.id]) {
                hasNew = true;
                this._graphs[server.id] = this.createGraph(server);
            }
        }.bind(this));

        // Remove old graphs
        for (var serverId in this._graphs) {
            if (serverIds.indexOf(parseInt(serverId)) == -1) {
                this.destroyGraph(this._graphs[serverId]);
                delete this._graphs[serverId];
            }
        }

        // Ping (if needed)
        if (hasNew)
            this.ping();
    },

    /**
     * Update the servers data after a vue servers fetch.
     */
    updateData: function () {
        for (var serverId in this._graphs) {
            var graph = this._graphs[serverId];

            var data = graph.series[0].data;
            if (data.length > 0) {
                for (var i in this._vueServersList.servers) {
                    var server = this._vueServersList.servers[i];

                    if (server.id == serverId) {
                        this.updateServerProgress(server, data);
                        break;
                    }
                }
            }
        }
    },

    /**
     * Destroy graphs, unbind events, ...
     */
    destroy: function () {
        // Unbind events
        $(window).unbind('resize', this._onWindowResize);

        this.stopPingTask();
        for (var serverId in this._graphs) {
            this.destroyGraph(this._graphs[serverId]);
            delete this._graphs[serverId];
        }
    },

    // - Private part

    /**
     * Create a new graph for a server
     * @param server the vue server data
     * @returns the graph
     */
    createGraph: function (server) {
        var graph = new Highcharts.Chart({
            chart: {
                renderTo: $('#server-' + server.id).find('.graph-container')[0],
                type: 'spline',
                animation: Highcharts.svg,
                spacingLeft: 0,
                spacingBottom: 0,
                backgroundColor: null
            },
            title: null,
            xAxis: {
                type: 'datetime',
                tickPixelInterval: 100,
                labels: {
                    formatter: function () {
                        return moment(this.value).format('LT');
                    }
                }
            },
            yAxis: {
                title: {
                    text: null
                },
                floor: 0,
                plotLines: [{
                    value: 0,
                    width: 1,
                    color: '#808080'
                }]
            },
            tooltip: {
                useHTML: true,
                formatter: function () {
                    return '<b>' + this.y.format(0, 3, ' ') + '</b><br>' +
                        moment(this.x).format('LTS');
                },
                positioner: function (labelWidth, labelHeight, point) {
                    return {
                        x: point.plotX,
                        y: -labelHeight
                    };
                }
            },
            legend: {
                enabled: false
            },
            exporting: {
                enabled: false
            },
            series: [{
                name: 'Players',
                marker: {
                    enabled: false
                }
            }],
            credits: {
                enabled: false
            }
        });
        graph.serverId = server.id;
        graph.firstFilled = false;
        graph.serieUpdated = 0;
        graph.currentMaxId = 0;
        return graph;
    },

    /**
     * Destroy specified graph.
     * (It is not removed from the list of graphs !)
     *
     * @param graph the graph
     */
    destroyGraph: function (graph) {
        graph.destroy();
    },

    /**
     * Ping the servers (and schedule the next ping if needed)
     */
    ping: function () {
        this.stopPingTask(); // Cancel already scheduled ping task

        // List servers-id to ping
        var servers = [];
        var newServers = [];
        for (var serverId in this._graphs) {
            var graph = this._graphs[serverId];
            if (this._pingMaxId !== null && !graph.firstFilled) {
                newServers.push(serverId);
            } else {
                servers.push(serverId);
            }
        }

        if (servers.length == 0 && newServers.length == 0) {
            return;
        }

        // HTTP request
        var always = function () {
            this._pingTask = setTimeout(function () {
                this.ping();
            }.bind(this), Config.get('minestats.ui_update_interval'));
        }.bind(this);
        var markFirstFill = function (serverId) {
            this._graphs[serverId].firstFilled = true;
        }.bind(this);

        var params = {
            servers: servers.join(',')
        };
        if (newServers.length)
            params.new_servers = newServers.join(',');
        if (this._pingMaxId !== null)
            params.max_id = this._pingMaxId;
        this._vueServersList.$http.get('/api/servers/stats/realtime?' + $.param(params)).then(function (res) {
            always();

            servers.forEach(markFirstFill);
            newServers.forEach(markFirstFill);
            var data = res.body;
            this._pingMaxId = data.max_id;
            this.updateStats(data.min_date, data.stats);
        }.bind(this), function (res) {
            always();
            notify.ajaxError('Unable to update realtime graph', res);
        }.bind(this));
    },

    /**
     * Cancel the programmed ping task (if there is one).
     */
    stopPingTask: function () {
        if (this._pingTask !== null) {
            clearTimeout(this._pingTask);
            this._pingTask = null;
        }
    },

    /**
     * Update graphs from stats list
     *
     * @param minDate minimum date
     * @param stats a stats list
     */
    updateStats: function (minDate, stats) {
        // Add new points
        // var redrawPointsThreshold = 2;
        stats.forEach(function (stat) {
            var graph = this._graphs[stat.server_id];
            if (!graph) {
                console.error('Received ping info for unknown server:' + stat.server_id);
            } else if (stat.id > graph.currentMaxId) {
                graph.currentMaxId = stat.id;
                graph.series[0].addPoint({
                    x: moment.utc(stat.recorded_at).unix() * 1000,
                    y: stat.players
                }, false);
                graph.serieUpdated = true;
            }
        }.bind(this));

        // Remove old points & update render
        var minX = moment.utc(minDate).unix() * 1000;
        for (var serverId in this._graphs) {
            var graph = this._graphs[serverId];

            if (graph.serieUpdated) {
                graph.serieUpdated = false;
                var data = graph.series[0].data;

                // Redraw for addPoint
                // We must redraw before removing points to avoid errors with Highchart in console
                graph.redraw();

                // Remove old points
                while (data.length > 0 && data[0].x < minX) {
                    graph.series[0].removePoint(0, false);
                }

                // Update vue
                if (data.length > 0) {
                    for (var i in this._vueServersList.servers) {
                        var server = this._vueServersList.servers[i];
                        if (server.id == serverId) {
                            var playersCount = data[data.length - 1].y;
                            if (playersCount == -1) {
                                server.failed_ping_count++;
                                if (server.failed_ping_count >= 3) { // TODO(nathan818): Config value (same than Server)
                                    server.players = playersCount;
                                }
                            } else {
                                server.failed_ping_count = 0;
                                server.players = playersCount;
                            }
                            this.updateServerProgress(server, data);
                            break;
                        }
                    }
                }
            }
        }
    },

    updateServerProgress: function (server, data) {
        if (data.length < 2)
            return;
        var i = 0;
        var min = -1;
        while (min < 0 && i < data.length && i < 10) {
            min = data[i].y;
            i++;
        }
        i = 0;
        var max = -1;
        while (max < 0 && i < data.length && i < 10) {
            max = data[data.length - 1 - i].y;
            i++;
        }
        this._vueServersList.$set(server, 'playersProgress', max - min);
    }
};

/*
 * Servers list vue
 */
var vueMultiselect = function (el, onChange) {
    el.multiselect({
        nonSelectedText: Lang.get('general.all'),
        allSelectedText: Lang.get('general.all'),
        selectAllNumber: true,
        enableHTML: true,
        onChange: onChange
    });
};

const serversList = new Vue({
    el: '#servers-list',

    data: function () {
        var data = {
            loaded: false,
            servers: [],
            filters: {
                show: false,
                languages: [],
                versions: [],
                secondaryLanguages: false,
                types: []
            },
            options: {
                expanded: false,
                showServersGraph: false
            },
            errors: {}
        };
        var filters = store.get('minestats.serversList.filters');
        if (filters) {
            _.assign(data.filters, filters);
        }
        var options = store.get('minestats.serversList.options');
        if (options) {
            _.assign(data.options, options);
        }
        return data;
    },

    watch: {
        'filters.languages': 'filtersUpdated',
        'filters.versions': 'filtersUpdated',
        'filters.secondaryLanguages': 'filtersUpdated',
        'filters.types': 'filtersUpdated'
    },

    created: function () {
        this.serversGraph = null;
        this.serversRealtimeGraphs = new ServersRealtimeGraphs(this);
        this.fetchServers();

        // Full reload every 5 minutes
        this.fetchServersTimer = setInterval(function () {
            this.fetchServers();
        }.bind(this), 5 * 60 * 1000);
    },

    mounted: function () {
        var self = this;
        vueMultiselect($('select[name=languages]', this.$el), function () {
            self.filters.languages = this.$select.val();
        });
        vueMultiselect($('select[name=versions]', this.$el), function () {
            self.filters.versions = this.$select.val();
        });
        vueMultiselect($('select[name=types]', this.$el), function () {
            self.filters.types = this.$select.val();
        });
    },

    updated: function () {
        this.serversRealtimeGraphs.updateServers();
        this.serversRealtimeGraphs.reflowContainers();
        this.serversGraph && this.serversGraph.reflowContainers();
        if (this.options.showServersGraph && this.serversGraph === null) {
            this.serversGraph = new ServersGraph(function () {
                return $('#global-graph');
            }, function () {
                var serversIds = [];
                var orderedServers = this.orderedServers;
                for (var i in orderedServers) {
                    serversIds.push(orderedServers[i].id);
                }
                return serversIds;
            }.bind(this), function (serverId) {
                var server;
                for (var i in this.servers) {
                    if (this.servers[i].id == serverId) {
                        server = this.servers[i];
                        break;
                    }
                }

                return {
                    name: server.name,
                    color: '#' + server.color
                }
            }.bind(this));
        }
    },

    beforeDestroy: function () {
        this.serversRealtimeGraphs.destroy();
        clearInterval(this.fetchServersTimer);
    },

    methods: {
        fetchServers: function () {
            var options = {
                with: 'icon,versions,languages',
                secondaryLanguages: this.filters.secondaryLanguages ? '1' : '0'
            };
            if (this.filters.languages.length)
                options.languages = this.filters.languages.join(',');
            if (this.filters.versions.length)
                options.versions = this.filters.versions.join(',');
            if (this.filters.types.length)
                options.types = this.filters.types.join(',');
            this.$http.get('/api/servers?' + $.param(options)).then(function (res) {
                this.loaded = true;
                this.servers = res.body;
                this.serversRealtimeGraphs.updateData();
                this.serversGraph && this.serversGraph.updateGraphData();
            }, function (res) {
                console.log(notify);
                notify.ajaxError('Unable to update servers list', res);
                if (!this.loaded) {
                    setTimeout(function () {
                        this.fetchServers();
                    }.bind(this), 4000);
                }
            });
        },
        filtersUpdated: _.throttle(function () {
            this.saveFilters();
            this.fetchServers();
        }, 2500),
        saveFilters: function () {
            store.set('minestats.serversList.filters', {
                show: this.filters.show,
                languages: this.filters.languages,
                versions: this.filters.versions,
                secondaryLanguages: this.filters.secondaryLanguages,
                types: this.filters.types
            });
        },
        resetFilters: function () {
            console.log($('select[name=languages]', this.$el));
            this.filters.languages = [];
            $('select[name=languages]', this.$el).multiselect('deselectAll', false).multiselect('updateButtonText');
            this.filters.versions = [];
            $('select[name=versions]', this.$el).multiselect('deselectAll', false).multiselect('updateButtonText');
            this.filters.types = [];
            $('select[name=types]', this.$el).multiselect('deselectAll', false).multiselect('updateButtonText');
        },
        toggleExpandedOption: function () {
            this.options.expanded = !this.options.expanded;
            var savedOptions = {
                expanded: this.options.expanded
            };
            store.set('minestats.serversList.options', savedOptions);
        },
        toggleServersGraphOption: function () {
            this.options.showServersGraph = !this.options.showServersGraph;
        }
    },

    computed: {
        orderedServers: function () {
            return _.sortBy(this.servers, function (server) {
                return -server.players;
            });
        },
        activeFiltersCount: function () {
            var count = 0;
            this.filters.languages.length > 0 && count++;
            this.filters.versions.length > 0 && count++;
            this.filters.types.length > 0 && count++;
            return count;
        }
    }
});