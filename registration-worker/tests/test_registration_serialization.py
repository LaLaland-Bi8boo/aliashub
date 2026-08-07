from application.tasks import TASK_STATUS_PENDING, claim_next_runnable_task, create_register_task, get_task


def test_register_tasks_share_explicit_mailbox_serial_key():
    first = create_register_task({
        "platform": "chatgpt",
        "email": "base+first@icloud.com",
        "extra": {"registration_serial_key": "icloud-link:mailbox-hash"},
    })
    second = create_register_task({
        "platform": "chatgpt",
        "email": "base+second@icloud.com",
        "extra": {"registration_serial_key": "icloud-link:mailbox-hash"},
    })

    claimed = claim_next_runnable_task(max_parallel_per_platform=2)
    assert claimed["id"] == first["task_id"]
    assert claimed["account_keys"] == ["registration:icloud-link:mailbox-hash"]

    blocked = claim_next_runnable_task(
        busy_account_keys=set(claimed["account_keys"]),
        max_parallel_per_platform=2,
    )
    assert blocked is None
    assert get_task(second["task_id"])["status"] == TASK_STATUS_PENDING


def test_register_tasks_without_serial_key_keep_existing_scheduler_behavior():
    first = create_register_task({"platform": "chatgpt", "email": "first@example.com", "extra": {}})
    second = create_register_task({"platform": "chatgpt", "email": "second@example.com", "extra": {}})

    claimed = claim_next_runnable_task(max_parallel_per_platform=2)
    assert claimed["id"] == first["task_id"]
    assert claimed["account_keys"] == []

    next_claimed = claim_next_runnable_task(max_parallel_per_platform=2)
    assert next_claimed["id"] == second["task_id"]
