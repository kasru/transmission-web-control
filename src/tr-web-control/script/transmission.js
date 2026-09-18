// transmission RPC 操作类
// 栽培者
var transmission = {
	SessionId: "",
	isInitialized: false,
	host: "",
	port: "9091",
	path: "/transmission/rpc",
	rpcpath: "../rpc",
	fullpath: "",
	on: {
		torrentCountChange: null,
		postError: null
	},
	username: "",
	password: "",
	// 种子状态
	_status: {
		stopped: 0,
		checkwait: 1,
		check: 2,
		downloadwait: 3,
		download: 4,
		seedwait: 5,
		seed: 6,
		// 自定义状态
		actively: 101
	},
	// TrackerStats' announceState
	_trackerStatus: {
		inactive: 0,
		waiting: 1,
		queued: 2,
		active: 3
	},
	options: {
		getFolders: true,
		getTarckers: true
	},
	headers: {},
	// --- Transmission 4.x compatibility ---
	// Detected RPC version of the connected daemon (0 = not known yet).
	// Transmission 4.0+ uses rpc-version >= 16 and renamed several session fields.
	// FreshTomato builds of Transmission 4.1.3 (rpc-version 19) still speak the
	// legacy JSON-RPC 1.0 protocol (method + arguments) and answer HTTP 204 to a
	// JSON-RPC 2.0 envelope, so we always keep the legacy request format here.
	rpcVersion: 0,
	// legacy (Transmission <= 3.x) session field name -> Transmission 4.x name
	_sessionFieldLegacyToV4: {
		"ratio-limit": "seedRatioLimit",
		"ratio-limit-enabled": "seedRatioLimited",
		"idle-limit-seedminutes": "idle-seeding-limit",
		"idle-limit-seedminutes-enabled": "idle-seeding-limit-enabled"
	},
	isV4: function() {
		return this.rpcVersion >= 16;
	},
	// rename keys of `args` according to `map` (only when target not already set)
	_renameSessionFields: function(args, map) {
		if (!args) return args;
		for (var from in map) {
			if (!Object.prototype.hasOwnProperty.call(map, from)) continue;
			var to = map[from];
			if (Object.prototype.hasOwnProperty.call(args, from) && args[to] === undefined) {
				args[to] = args[from];
				delete args[from];
			}
		}
		return args;
	},
	_reverseMap: function(map) {
		var out = {};
		for (var k in map) {
			if (Object.prototype.hasOwnProperty.call(map, k)) out[map[k]] = k;
		}
		return out;
	},
	trackers: {},
	islocal: false,
	// The list of directories that currently exist
	downloadDirs: new Array(),
	getSessionId: function(me, callback) {
		var settings = {
			type: "POST",
			url: this.fullpath,
			error: function(request, event, settings) {
				var SessionId = "";
				if (request.status === 409 && (SessionId = request.getResponseHeader('X-Transmission-Session-Id'))) {
					me.isInitialized = true;
					me.SessionId = SessionId;
					me.headers["X-Transmission-Session-Id"] = SessionId;
					if (callback) {
						callback();
					}
				}
			},
			headers: this.headers

		};
		jQuery.ajax(settings);
	},
	init: function(config, callback) {
		jQuery.extend(this, config);

		/*
		if (this.fullpath=="")
		{
			this.fullpath = this.host + (this.port?":"+this.port:"") + this.path;
		}*/
		if (this.username && this.password) {
			this.headers["Authorization"] = "Basic " + (new Base64()).encode(this.username + ":" + this.password);
		}

		this.fullpath = this.rpcpath;
		this.getSessionId(this, callback);
	},
	/**
	 * 执行指定的命令
	 * @param  {[type]}   config   [description]
	 * @param  {Function} callback [description]
	 * @param  {[type]}   tags     [description]
	 * @return {[type]}            [description]
	 */
	exec: function(config, callback, tags) {
		if (!this.isInitialized) {
			return false;
		}
		var data = {
			method: "",
			arguments: {},
			tag: ""
		};

		jQuery.extend(data, config);

		// Compatibility: the UI always uses Transmission 4.x session field names.
		// When talking to an older daemon (rpc-version < 16) translate them back
		// to the legacy names so session-set is accepted. On 4.x this is a no-op.
		if (data.method === "session-set" && this.rpcVersion && !this.isV4()) {
			this._renameSessionFields(data.arguments, this._reverseMap(this._sessionFieldLegacyToV4));
		}

		var settings = {
			type: "POST",
			url: this.fullpath,
			dataType: 'json',
			data: JSON.stringify(data),
			success: function(resultData, textStatus) {
				// Remember the daemon RPC version and normalize legacy field names
				// to the 4.x names the UI expects (e.g. ratio-limit -> seedRatioLimit).
				if (resultData && resultData.arguments) {
					if (typeof resultData.arguments["rpc-version"] === "number") {
						transmission.rpcVersion = resultData.arguments["rpc-version"];
					}
					if (transmission.rpcVersion && !transmission.isV4()) {
						transmission._renameSessionFields(resultData.arguments, transmission._sessionFieldLegacyToV4);
					}
				}
				if (callback) {
					callback(resultData, tags);
				}
			},
			error: function(request, event, page) {
				var SessionId = "";
				if (request.status === 409 && (SessionId = request.getResponseHeader('X-Transmission-Session-Id'))) {
					transmission.SessionId = SessionId;
					transmission.headers["X-Transmission-Session-Id"] = SessionId;
					jQuery.ajax(settings);
				} else {
					if (transmission.on.postError) {
						transmission.on.postError(request);
					}
				}
			},
			headers: this.headers
		};
		jQuery.ajax(settings);
	},
	getStatus: function(callback) {
		this.exec({
			method: "session-stats"
		}, function(data) {
			if (data.result == "success") {
				if (callback) {
					callback(data.arguments);
				}

				if (transmission.torrents.count != data.arguments.torrentCount || transmission.torrents.activeTorrentCount != data.arguments.activeTorrentCount || transmission.torrents.pausedTorrentCount != data.arguments.pausedTorrentCount) {
					// Current total number of torrents
					transmission.torrents.count = data.arguments.torrentCount;
					transmission.torrents.activeTorrentCount = data.arguments.activeTorrentCount;
					transmission.torrents.pausedTorrentCount = data.arguments.pausedTorrentCount;
					transmission._onTorrentCountChange();
				}
			}
		});
	},
	getSession: function(callback) {
		this.exec({
			method: "session-get"
		}, function(data) {
			if (data.result == "success") {
				if (callback) {
					callback(data.arguments);
				}
			}
		});
	},
	// 添加种子
	addTorrentFromUrl: function(url, savepath, autostart, callback) {
		// 磁性连接（代码来自原版WEBUI）
		if (url.match(/^[0-9a-f]{40}$/i)) {
			url = 'magnet:?xt=urn:btih:' + url;
		}
		var options = {
			method: "torrent-add",
			arguments: {
				filename: url,
				paused: (!autostart)
			}
		};

		if (savepath) {
			options.arguments["download-dir"] = savepath;
		}
		this.exec(options, function(data) {
			switch (data.result) {
				// 添加成功
				case "success":
					if (callback) {
						if (data.arguments["torrent-added"]) {
							callback(data.arguments["torrent-added"]);
						}
						// 重复的种子
						else if (data.arguments["torrent-duplicate"]) {
							callback({
								status: "duplicate",
								torrent: data.arguments["torrent-duplicate"]
							});
						}

					}
					break;

					// 重复的种子
				case "duplicate torrent":
				default:
					if (callback) {
						callback(data.result);
					}
					break;

			}
		});
	},
	// 从文件内容增加种子
	addTorrentFromFile: function(file, savePath, paused, callback, filecount) {
		var fileReader = new FileReader();

		fileReader.onload = function(e) {
			var contents = e.target.result;
			var key = "base64,";
			var index = contents.indexOf(key);
			if (index == -1) {
				return;
			}
			var metainfo = contents.substring(index + key.length);

			transmission.exec({
				method: "torrent-add",
				arguments: {
					metainfo: metainfo,
					"download-dir": savePath,
					paused: paused
				}
			}, function(data) {
				switch (data.result) {
					// 添加成功
					case "success":
						if (callback) {
							if(data.arguments["torrent-added"] != null)
								callback(data.arguments["torrent-added"], filecount);
							else if (data.arguments["torrent-duplicate"] != null)
								callback({
									status: "duplicate",
									torrent: data.arguments["torrent-duplicate"]
									}, filecount);
							else
								callback("error");
						}
						break;
						// 重复的种子
					case "duplicate torrent":
						if (callback) {
							callback("duplicate");
						}
						break;

				}
			});
		}
		fileReader.readAsDataURL(file);

	},
	_onTorrentCountChange: function() {
		this.torrents.loadSimpleInfo = false;
		if (this.on.torrentCountChange) {
			this.on.torrentCountChange();
		}
	},
	// 删除种子
	removeTorrent: function(ids, removeData, callback) {
		this.exec({
			method: "torrent-remove",
			arguments: {
				ids: ids,
				"delete-local-data": removeData
			}
		}, function(data) {
			if (callback)
				callback(data.result);
		});
	},
	// 獲取指定目錄的大小
	getFreeSpace: function(path, callback) {
		this.exec({
			method: "free-space",
			arguments: {
				"path": path
			}
		}, function(result) {
			if (callback)
				callback(result);
		});
	},
	// 更新黑名單
	updateBlocklist: function(callback) {
		this.exec({
			method: "blocklist-update"
		}, function(data) {
			if (callback)
				callback(data.result);
		});
	},
	// 重命名指定的种子文件/目录名称
	// torrentId 		只能指定一个
	// oldpath 			原文件路径或目录，如：opencd/info.txt 或 opencd/cd1
	// newname			新的文件或目录名，如：into1.txt 或 disc1
	renameTorrent: function(torrentId, oldpath, newname, callback) {
		var torrent = this.torrents.all[torrentId];
		if (!torrent)
			return false;

		this.exec({
			method: "torrent-rename-path",
			arguments: {
				ids: [torrentId],
				path: oldpath || torrent.name,
				name: newname
			}
		}, function(data) {
			if (callback)
				callback(data);
		});
	},
	// 关闭连接？		
	closeSession: function(callback) {
		this.exec({
			method: "session-close"
		}, function(result) {
			if (callback)
				callback(result);
		});
	}
};

/*
(function($){
	var items = $("script");
	var index = -1;
	for (var i=0;i<items.length ;i++ )
	{
		var src = items[i].src.toLowerCase();
		index = src.indexOf("min/transmission.js");
		if (index!=-1)
		{
			// 种子相关信息
			$.getScript("script/min/transmission.torrents.js");
			break;
		}
	}
	if (index==-1)
	{
		$.getScript("script/transmission.torrents.js");
	}
})(jQuery);
*/