Feature: Manejo de Errores
  Como usuario
  Quiero recibir mensajes claros cuando ocurran errores
  Para entender qué pasó y cómo solucionarlo

  Background:
    Given la aplicación Jellysync está iniciada

  Scenario: Servidor Jellyfin no disponible
    Given el usuario ha configurado un servidor válido
    When el servidor Jellyfin está caído
    And el usuario intenta conectar
    Then debería mostrarse un mensaje de error amigable
    And el mensaje debería decir "No se puede conectar al servidor"
    And debería mostrar "Verifica que el servidor esté encendido"
    And debería ofrecer la opción "Reintentar"

  Scenario: Timeout de conexión
    Given el usuario está intentando conectar
    When el servidor tarda más de 30 segundos en responder
    Then debería mostrarse el mensaje "Tiempo de espera agotado"
    And debería sugerir "Verifica tu conexión a internet"
    And el botón "Reintentar" debería estar disponible

  Scenario: Error de autenticación
    Given el usuario ingresa credenciales
    When la API key ha expirado
    Then debería mostrarse el mensaje "Sesión expirada"
    And debería indicar "Por favor, genera una nueva API key"
    And debería redirigir a la pantalla de login

  Scenario: Error de red
    Given el usuario está navegando la biblioteca
    When se pierde la conexión a internet
    Then debería mostrarse el mensaje "Sin conexión"
    And debería mostrarse el contenido en caché si está disponible
    And debería mostrar el estado "Modo offline"

  Scenario: Error al leer biblioteca
    Given el usuario está conectado
    When ocurre un error al cargar la biblioteca
    Then debería mostrarse el mensaje "Error al cargar la biblioteca"
    And debería mostrar el detalle del error
    And debería ofrecer "Reintentar" o "Ver logs"

  Scenario: Archivo corrupto durante sincronización
    Given la sincronización está en progreso
    When se encuentra un archivo corrupto
    Then debería registrar el error en logs
    And debería continuar con la siguiente canción
    And al finalizar debería mostrar "Algunos archivos no se sincronizaron"
    And debería ofrecer ver el reporte de errores

  Scenario: Dispositivo de destino sin permisos de escritura
    Given hay un dispositivo USB conectado
    When el dispositivo está protegido contra escritura
    And el usuario intenta sincronizar
    Then debería mostrarse el mensaje "No se puede escribir en el dispositivo"
    And debería sugerir "Verifica que el dispositivo no esté bloqueado"

  Scenario: Error desconocido
    Given ocurre un error inesperado
    Then debería mostrarse un mensaje genérico amigable
    And no debería mostrarse código de error técnico al usuario
    And debería ofrecer la opción "Ver detalles técnicos"
    And los detalles técnicos deberían estar disponibles para soporte