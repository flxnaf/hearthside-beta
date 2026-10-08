extends SceneTree
# Test-only wrapper around the exact exported game; no invitations or secrets logged.
var game:Node
var elapsed:=0.0
var next_report:=0.0
func _initialize()->void:call_deferred("run")
func run()->void:
	game=load("res://scenes/main.tscn").instantiate();root.add_child(game)
	print("STARTUP_PROBE os=",OS.get_name()," architecture=",Engine.get_architecture_name()," editor=",OS.has_feature("editor"))
func _process(delta:float)->bool:
	elapsed+=delta
	if not is_instance_valid(game):return false
	if elapsed>=next_report:
		next_report=elapsed+1
		print("STARTUP_PROBE seconds=",snappedf(elapsed,.1)," joining=",game.joining," connected=",game.connected," socket=",game.socket.get_ready_state()," attempted=",game.local_attempted," pid=",game.local_room.process_id," phase=",game.qa_local_phase," error=",game.local_room.error," status=",game.status_label.text)
	return false
