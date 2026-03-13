Feature: Sincronización de Música
  Como usuario
  Quiero sincronizar música a mi dispositivo USB
  Para escuchar música offline

  Background:
    Given el usuario está autenticado en Jellyfin
    And la biblioteca está cargada

  Scenario: Detectar dispositivo USB conectado
    Given el usuario está en la pantalla de biblioteca
    When un dispositivo USB es conectado
    Then debería detectarse el dispositivo automáticamente
    And debería mostrarse el nombre del dispositivo
    And debería mostrar el espacio disponible
    And el botón "Sincronizar" debería habilitarse

  Scenario: Seleccionar canciones individuales
    Given el usuario está viendo canciones de un álbum
    When el usuario marca la casilla de la canción "Come Together"
    And el usuario marca la casilla de la canción "Something"
    Then el contador de canciones seleccionadas debería mostrar "2"
    And el indicador de espacio requerido debería actualizarse

  Scenario: Seleccionar álbum completo
    Given el usuario está viendo un álbum
    When el usuario marca la casilla "Seleccionar todo"
    Then todas las canciones del álbum deberían estar marcadas
    And el contador debería mostrar el total de canciones del álbum

  Scenario: Sincronización exitosa
    Given hay un dispositivo USB conectado
    And el usuario ha seleccionado 5 canciones
    When el usuario hace click en el botón "Sincronizar"
    Then debería iniciarse el proceso de sincronización
    And debería mostrarse una barra de progreso
    When la sincronización completa
    Then debería mostrarse el mensaje "Sincronización completada"
    And las canciones deberían estar en el dispositivo USB

  Scenario: Cancelar sincronización en curso
    Given la sincronización está en progreso
    When el usuario hace click en el botón "Cancelar"
    Then la sincronización debería detenerse
    And los archivos parcialmente copiados deberían eliminarse
    And debería mostrarse el mensaje "Sincronización cancelada"

  Scenario: Espacio insuficiente en dispositivo
    Given hay un dispositivo USB conectado
    And el usuario ha seleccionado canciones que exceden el espacio disponible
    When el usuario hace click en el botón "Sincronizar"
    Then debería mostrarse el mensaje "Espacio insuficiente"
    And debería mostrar cuánto espacio adicional se necesita
    And la sincronización no debería iniciarse

  Scenario: Dispositivo desconectado durante sincronización
    Given la sincronización está en progreso
    When el dispositivo USB es desconectado
    Then debería mostrarse el mensaje "Dispositivo desconectado"
    And la sincronización debería pausarse
    And el botón "Reintentar" debería estar disponible