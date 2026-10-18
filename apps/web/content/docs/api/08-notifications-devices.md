---
title: Notifications and devices
description: The redacted notification inbox and push device registry.
---

Notifications are redacted summaries with a deep link; they never carry amounts, counterparties or message text. Only a native device session can register a push token (`NATIVE_SESSION_REQUIRED` otherwise). Signing out or revoking a session stops pushes to its devices and skips their queued deliveries.

## Routes

### GET /v3/notifications

Redacted notification inbox.

|              |                            |
| ------------ | -------------------------- |
| Route id     | `notifications.list`       |
| Auth         | Session (bearer or cookie) |
| Who may call | principal                  |
| Status       | IMPLEMENTED                |

**Query parameters**

| Field    | Type                     | Required | Notes |
| -------- | ------------------------ | -------- | ----- |
| `cursor` | string (max 200, min 1)  | no       |       |
| `limit`  | integer (min 1, max 100) | no       |       |

**Response** ([NotificationPage](/docs/api/schemas#notificationpage))

| Field         | Type                                                   | Required | Notes |
| ------------- | ------------------------------------------------------ | -------- | ----- |
| `items`       | [AppNotification](/docs/api/schemas#appnotification)[] | yes      |       |
| `nextCursor`  | string (max 200, min 1) or null                        | yes      |       |
| `unreadCount` | integer (min 0)                                        | yes      |       |

Example response (synthetic fixture):

```json
{
  "items": [
    {
      "notificationId": "00000000-0000-4000-8000-000000000028",
      "eventId": "00000000-0000-4000-8000-000000000029",
      "category": "NEW_LEAD",
      "workspaceId": "00000000-0000-4000-8000-000000000001",
      "title": "New enquiry",
      "deepLink": "/w/00000000-0000-4000-8000-000000000001/inbox/00000000-0000-4000-8000-000000000003",
      "createdAt": "2026-10-17T10:03:00.000Z",
      "readAt": null
    }
  ],
  "nextCursor": null,
  "unreadCount": 1
}
```

### POST /v3/notifications/read

Mark notifications read.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `notifications.read`                                    |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | principal                                               |
| Status       | IMPLEMENTED                                             |

**Request body** ([MarkRead](/docs/api/schemas#markread))

| Field             | Type                     | Required | Notes |
| ----------------- | ------------------------ | -------- | ----- |
| `notificationIds` | uuid[] (min 1) (max 200) | yes      |       |

**Response** ([Ok](/docs/api/schemas#ok))

| Field | Type   | Required | Notes |
| ----- | ------ | -------- | ----- |
| `ok`  | `true` | yes      |       |

### POST /v3/devices

Register or update an APNs token and preferences.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `devices.register`                                      |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | native session of that device                           |
| Status       | IMPLEMENTED                                             |

**Request body** ([DeviceRegistration](/docs/api/schemas#deviceregistration))

| Field             | Type                                                             | Required | Notes |
| ----------------- | ---------------------------------------------------------------- | -------- | ----- |
| `deviceId`        | uuid                                                             | yes      |       |
| `apnsToken`       | string (`^[0-9a-f]{64,200}$`)                                    | yes      |       |
| `environment`     | `SANDBOX`, `PRODUCTION`                                          | yes      |       |
| `locale`          | string (max 20)                                                  | yes      |       |
| `mutedCategories` | [NotificationCategory](/docs/api/schemas#notificationcategory)[] | yes      |       |
| `quietHours`      | object or null                                                   | yes      |       |

**Response** ([DeviceRegistered](/docs/api/schemas#deviceregistered))

| Field          | Type          | Required | Notes                  |
| -------------- | ------------- | -------- | ---------------------- |
| `deviceId`     | uuid          | yes      |                        |
| `registeredAt` | ISO-8601 time | yes      | UTC ISO-8601 timestamp |

### POST /v3/devices/{deviceId}/revoke

Stop pushes to a device.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `devices.revoke`                                        |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | principal                                               |
| Status       | IMPLEMENTED                                             |

Path parameters: `deviceId` (UUIDs unless stated).

**Response** ([Ok](/docs/api/schemas#ok))

| Field | Type   | Required | Notes |
| ----- | ------ | -------- | ----- |
| `ok`  | `true` | yes      |       |
