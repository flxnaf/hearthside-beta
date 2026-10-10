extends SceneTree
## Run with the exported executable; no local profile, seat, or study history.
var request: HTTPRequest
var socket := WebSocketPeer.new()
var elapsed := 0.0
var connecting := false
var sent := false
var finished := false
func _initialize() -> void:
	_start.call_deferred()
func _start() -> void:
	var catalog = JSON.parse_string(FileAccess.get_file_as_string("res://world/public-halls.json"))
	request = HTTPRequest.new()
	request.timeout = 12
	request.body_size_limit = 32768
	request.max_redirects = 0
	root.add_child(request)
	request.request_completed.connect(_directory)
	if request.request(str(catalog.directoryUrl)) != OK:_fail("Directory request could not start")
func _directory(result: int, status: int, _headers: PackedStringArray, body: PackedByteArray) -> void:
	if result != HTTPRequest.RESULT_SUCCESS or status != 200:
		_fail("Public directory result=%d HTTP=%d" % [result, status]);return
	var data = JSON.parse_string(body.get_string_from_utf8())
	if not data is Dictionary or not data.get("halls") is Array:
		_fail("Invalid public directory");return
	print("PUBLIC_DIRECTORY_PASS os=", OS.get_name())
	for hall in data.halls:
		if hall.get("online", false) and not hall.get("full", true):
			if socket.connect_to_url(str(hall.endpoint)) != OK:_fail("WebSocket could not start");return
			connecting = true
			return
	_fail("No available hall for the public connection test")
func _process(delta: float) -> bool:
	if finished:return false
	elapsed += delta
	if elapsed > 30:_fail("Public connection timed out");return false
	if not connecting:return false
	socket.poll()
	if socket.get_ready_state() == WebSocketPeer.STATE_CLOSED:
		_fail("Public WebSocket closed before welcome");return false
	if socket.get_ready_state() != WebSocketPeer.STATE_OPEN:return false
	if not sent:
		socket.send_text(JSON.stringify({"type":"join", "name":"Connection check", "character":"male", "appearance":"jun", "outfit":"everyday", "capabilities":{"hallLayouts":1,"stateDelta":1}}))
		sent = true
	while socket.get_available_packet_count() > 0:
		var packet = JSON.parse_string(socket.get_packet().get_string_from_utf8())
		if not packet is Dictionary:continue
		if packet.get("type") == "welcome":
			print("PUBLIC_JOIN_PASS os=", OS.get_name())
			socket.close(1000, "Connection check complete")
			socket.poll()
			finished = true
			quit(0)
		elif packet.get("type") == "error":_fail("Public hall rejected connection")
	return false
func _fail(message: String) -> void:
	finished = true
	push_error(message)
	socket.close()
	quit(1)
