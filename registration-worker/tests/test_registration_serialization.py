from application.tasks import TASK_TYPE_REGISTER, _task_account_keys


def test_register_tasks_share_explicit_mailbox_serial_key():
    first = {
        "email": "base+first@icloud.com",
        "extra": {"registration_serial_key": "icloud:mailbox-hash"},
    }
    second = {
        "email": "base+second@icloud.com",
        "extra": {"registration_serial_key": "icloud:mailbox-hash"},
    }

    assert _task_account_keys(TASK_TYPE_REGISTER, first) == ["registration:icloud:mailbox-hash"]
    assert _task_account_keys(TASK_TYPE_REGISTER, second) == ["registration:icloud:mailbox-hash"]


def test_register_tasks_without_serial_key_keep_existing_scheduler_behavior():
    payload = {"email": "user@example.com", "extra": {}}

    assert _task_account_keys(TASK_TYPE_REGISTER, payload) == []
