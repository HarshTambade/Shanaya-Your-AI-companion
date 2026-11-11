#include <uapi/linux/ptrace.h>
#include <linux/sched.h>

struct open_event_t {
    u32 pid;
    u32 uid;
    int flags;
    char comm[TASK_COMM_LEN];
    char filename[256];
};

BPF_PERF_OUTPUT(events);

TRACEPOINT_PROBE(syscalls, sys_enter_openat) {
    struct open_event_t event = {};
    u64 pid_tgid = bpf_get_current_pid_tgid();
    u64 uid_gid = bpf_get_current_uid_gid();

    event.pid = pid_tgid >> 32;
    event.uid = uid_gid & 0xffffffff;
    event.flags = args->flags;
    bpf_get_current_comm(&event.comm, sizeof(event.comm));
    bpf_probe_read_user_str(&event.filename, sizeof(event.filename), args->filename);
    events.perf_submit(args, &event, sizeof(event));
    return 0;
}
